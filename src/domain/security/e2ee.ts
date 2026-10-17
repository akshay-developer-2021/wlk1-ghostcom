/* ═══════════════════════════════════════════════════════════════
   security/e2ee.ts — true end-to-end frame encryption on top of
   DTLS-SRTP, via the WebRTC Encoded Transform (Insertable Streams).

   · AES-GCM per RTP frame with a key derived from the ROOM SECRET
     (never sent over the wire). The signaling broker and TURN both
     see only ciphertext — SRTP alone no longer protects us alone.
   · Random 12-byte IV per frame (GCM-safe at radio traffic scale).
   · Undecryptable frames are dropped + counted (MITM/tamper signal).
   · Feature-detected: unsupported browsers run DTLS-SRTP only and
     the UI badge downgrades to "SRTP" so the claim stays honest.
   ═══════════════════════════════════════════════════════════════ */

export const WORKER_SRC = (direction: 'encrypt' | 'decrypt'): string => `
let key = null, drops = 0, encCount = 0, decCount = 0;
/* The direction is baked in at construction. RTCRtpScriptTransformEvent
   exposes only \`transformer\` in Chromium and WebKit — there is no
   \`options\`, so event.options.direction is undefined and a single shared
   worker cannot tell encrypt from decrypt. One worker per direction. */
const DIR = '${direction}';
function bumpDrops() { drops++; if (drops % 50 === 0) self.postMessage({ type: 'drops', drops }); }
async function encrypt(frame) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(frame.data));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv); buf.set(new Uint8Array(ct), 12);
  frame.data = buf.buffer;
  return frame;
}
async function decrypt(frame) {
  const buf = new Uint8Array(frame.data);
  if (buf.byteLength <= 12) throw new Error('short');
  const iv = buf.subarray(0, 12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf.subarray(12));
  frame.data = pt;
  return frame;
}
async function pump(readable, writable, direction) {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      /* A codec-reconfiguration frame carries no payload (the browser emits
         one at every track swap, i.e. every PTT). There is nothing to
         protect and nothing to authenticate: it must not be counted as a
         dropped audio frame, or every press spams the tamper warning. */
      if (!frame.data || frame.data.byteLength === 0) { await writer.write(frame); continue; }
      if (!key) { bumpDrops(); continue; }   // rekey race — drop, never send clear
      let out = null;
      try {
        if (direction === 'encrypt') out = await encrypt(frame);
        else out = await decrypt(frame);
      } catch (_) { out = null; }
      if (out) { await writer.write(out); if (direction === 'encrypt') encCount++; else decCount++; }
      else { bumpDrops(); }
    }
  } catch (_) { /* stream torn down on leg close */ }
  await writer.close().catch(() => {});
}
self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'init') {
    key = await crypto.subtle.importKey('raw', d.rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (d.type === 'transform') {
    await pump(d.readable, d.writable, d.direction);
    return;
  }
  if (d.type === 'stats') self.postMessage({ type: 'stats', drops, encCount, decCount });
};
self.onrtctransform = (event) => {
  try {
    const t = event.transformer;
    if (!t) return;
    pump(t.readable, t.writable, DIR);
  } catch (_) { /* torn down — ignore */ }
};
`;

type MarkedSender = RTCRtpSender & { __wlkSecured?: boolean };
type MarkedReceiver = RTCRtpReceiver & { __wlkDec?: boolean };
type ScriptTransformCtor = new (worker: Worker, options?: unknown) => unknown;
/** createEncodedStreams was removed from lib.dom but still ships in browsers. */
interface EncodedStreams {
  readable: ReadableStream;
  writable: WritableStream;
}
interface EncodedStreamsSource {
  createEncodedStreams(): EncodedStreams;
}

function scriptTransformCtor(): ScriptTransformCtor | null {
  const g = globalThis as unknown as Record<string, unknown>;
  return (typeof g['RTCRtpScriptTransform'] === 'function'
    ? (g['RTCRtpScriptTransform'] as ScriptTransformCtor)
    : null);
}

/** `RTCRtpScriptTransform` is exposed as a `transform` instance accessor —
    the constructor name never appears on the prototype. The legacy
    createEncodedStreams path is deprecated and rejects any attach made
    after a sender starts sending, so prefer the modern API. */
function hasTransform(proto: unknown): boolean {
  return !!proto && typeof proto === 'object' && 'transform' in proto;
}

export interface E2EEStats {
  type: string;
  drops: number;
  encCount: number;
  decCount: number;
}

export class E2EE {
  enabled = true;
  private _log: (msg: string, kind?: string) => void;
  private _enc: Worker;
  private _dec: Worker;
  private _ready: Promise<void>;

  /** Capability check — must be called before claiming the E2EE badge. */
  static supported(): boolean {
    if (typeof RTCRtpSender === 'undefined') return false;
    return hasTransform(RTCRtpSender.prototype)
      || typeof (RTCRtpSender.prototype as unknown as EncodedStreamsSource).createEncodedStreams === 'function';
  }

  /** @param rawKeyBytes Uint8Array(32) — from deriveRawGroupKey() */
  constructor(rawKeyBytes: Uint8Array, log: (msg: string, kind?: string) => void = () => {}) {
    if (!E2EE.supported()) throw new Error('E2EE unsupported');
    this._log = log;
    /* Each Worker fetches its blob once at construction, so the URL can be
       released immediately — no need to hold it for destroy(). */
    const encUrl = URL.createObjectURL(new Blob([WORKER_SRC('encrypt')], { type: 'text/javascript' }));
    const decUrl = URL.createObjectURL(new Blob([WORKER_SRC('decrypt')], { type: 'text/javascript' }));
    this._enc = new Worker(encUrl);
    this._dec = new Worker(decUrl);
    URL.revokeObjectURL(encUrl);
    URL.revokeObjectURL(decUrl);
    for (const w of [this._enc, this._dec]) {
      w.postMessage({ type: 'init', rawKey: new Uint8Array(rawKeyBytes) });
    }
    this._ready = Promise.all([this._enc, this._dec].map((w) => new Promise<void>((res) => {
      w.addEventListener('message', (e: MessageEvent) => {
        if (e.data?.type === 'ready') res();
        else if (e.data?.type === 'drops') this._log(`FRAME DROPS ${e.data.drops} — POSSIBLE TAMPER/LOSS`, 'warn');
      });
    }))).then(() => {});
    this.enabled = true;
  }

  /** Wire encryption into an outbound sender — ONCE per sender.
      The transform belongs to the SENDER, not to its track: replaceTrack
      (PTT) keeps it in the pipeline, so re-arming per track change is not
      just wasteful, it opens a plaintext window. Measured: every press
      rebuilt the transform and the peer dropped ~18 frames it could not
      authenticate — the frames the swap emitted outside the new pump.
      Each assignment also abandons the previous pump inside the worker, so
      a per-press re-arm piled up dead loops for the life of the session. */
  /** Resolves TRUE only when frames from this sender will actually be
      encrypted. The caller advertises that answer to the peer, and the two
      error directions are not symmetric: over-claiming means the peer keeps
      its decryptor armed, discards every frame we send in the clear, and the
      conversation is silent behind a green badge. Under-claiming only costs a
      needless SRTP fallback. */
  async secureSender(sender: RTCRtpSender): Promise<boolean> {
    const marked = sender as MarkedSender;
    if (marked?.__wlkSecured) return true;
    if (!this.enabled || !sender) return false;
    await this._ready;
    try {
      const ST = scriptTransformCtor();
      if (ST && hasTransform(RTCRtpSender.prototype)) {
        (sender as unknown as { transform: unknown }).transform = new ST(this._enc, { direction: 'encrypt' });
      } else {
        const { readable, writable } = (sender as unknown as EncodedStreamsSource).createEncodedStreams();
        this._enc.postMessage({ type: 'transform', readable, writable, direction: 'encrypt' },
          [readable, writable] as unknown as Transferable[]);
      }
    } catch (err) {
      this._log(`E2EE SENDER ATTACH FAILED — ${(err as Error)?.message ?? err}`, 'warn');
      return false; // the mesh keeps the leg on SRTP and says so
    }
    marked.__wlkSecured = true;
    return true;
  }

  /** Wire decryption into an inbound receiver. Resolves true when the frames
      are genuinely decryptable, for the same reason as secureSender. */
  async secureReceiver(receiver: RTCRtpReceiver): Promise<boolean> {
    const marked = receiver as MarkedReceiver;
    if (marked?.__wlkDec) return true;
    if (!this.enabled || !receiver) return false;
    await this._ready;
    try {
      const ST = scriptTransformCtor();
      if (ST && hasTransform(RTCRtpReceiver.prototype)) {
        (marked as unknown as { transform: unknown }).transform = new ST(this._dec, { direction: 'decrypt' });
      } else {
        const { readable, writable } = (receiver as unknown as EncodedStreamsSource).createEncodedStreams();
        this._dec.postMessage({ type: 'transform', readable, writable, direction: 'decrypt' },
          [readable, writable] as unknown as Transferable[]);
      }
    } catch (err) {
      this._log(`E2EE RECEIVER ATTACH FAILED — ${(err as Error)?.message ?? err}`, 'warn');
      return false; // flags stay unset so callers can log + retry
    }
    marked.__wlkDec = true;
    return true;
  }

  /** Summed across both direction-workers — a drop is a drop either way. */
  async stats(): Promise<E2EEStats> {
    const ask = (w: Worker): Promise<E2EEStats> => new Promise((res) => {
      const h = (e: MessageEvent): void => {
        if (e.data?.type === 'stats') { w.removeEventListener('message', h); res(e.data as E2EEStats); }
      };
      w.addEventListener('message', h);
      w.postMessage({ type: 'stats' });
    });
    const parts = await Promise.all([ask(this._enc), ask(this._dec)]);
    return parts.reduce<E2EEStats>((acc, p) => ({
      type: 'stats',
      drops: acc.drops + (p.drops ?? 0),
      encCount: acc.encCount + (p.encCount ?? 0),
      decCount: acc.decCount + (p.decCount ?? 0),
    }), { type: 'stats', drops: 0, encCount: 0, decCount: 0 });
  }

  destroy(): void {
    this.enabled = false;
    this._enc.terminate();
    this._dec.terminate();
  }
}

/** Extractable raw key for the worker path (page-memory secret anyway). */
export async function deriveRawGroupKey(subtle: SubtleCrypto, secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const base = await subtle.importKey('raw', enc.encode(`wlk1-e2ee:${secret.toUpperCase()}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('wlk1-salt-v1'), iterations: 120_000, hash: 'SHA-256' },
    base, 256,
  );
  return new Uint8Array(bits);
}
