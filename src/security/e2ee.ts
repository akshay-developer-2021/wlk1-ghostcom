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

const WORKER_SRC = `
let key = null, drops = 0, encCount = 0, decCount = 0;
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
      if (!key) { drops++; continue; }   // rekey race — drop, never send clear
      let out = null;
      try {
        if (direction === 'encrypt') out = await encrypt(frame);
        else out = await decrypt(frame);
      } catch (_) { out = null; }
      if (out) { await writer.write(out); if (direction === 'encrypt') encCount++; else decCount++; }
      else { drops++; }
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
/* RTCRtpScriptTransform path: the browser pipes encoded frames here.
   Shares the same worker-global key; frames arriving before init
   are dropped + counted, never forwarded in the clear. */
self.onrtctransform = (event) => {
  try {
    const direction = event.options?.direction;
    const t = event.transformer;
    if (!t) return;
    pump(t.readable, t.writable, direction);
  } catch (_) { /* torn down — ignore */ }
};
`;

type MarkedSender = RTCRtpSender & { __wlkEnc?: boolean };
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

export interface E2EEStats {
  type: string;
  drops: number;
  encCount: number;
  decCount: number;
}

export class E2EE {
  enabled = true;
  private _log: (msg: string, kind?: string) => void;
  private _worker: Worker;
  private _ready: Promise<void>;

  /** Capability check — must be called before claiming the E2EE badge. */
  static supported(): boolean {
    if (typeof RTCRtpSender === 'undefined') return false;
    return 'RTCRtpScriptTransform' in RTCRtpSender.prototype
      || typeof (RTCRtpSender.prototype as unknown as EncodedStreamsSource).createEncodedStreams === 'function';
  }

  /** @param rawKeyBytes Uint8Array(32) — from crypto.deriveGroupKeyRaw() */
  constructor(rawKeyBytes: Uint8Array, log: (msg: string, kind?: string) => void = () => {}) {
    if (!E2EE.supported()) throw new Error('E2EE unsupported');
    this._log = log;
    this._worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    this._worker.postMessage(
      { type: 'init', rawKey: rawKeyBytes },
      [rawKeyBytes.buffer] as unknown as Transferable[],
    );
    this._ready = new Promise((res) => {
      this._worker.onmessage = (e: MessageEvent) => { if (e.data?.type === 'ready') res(); };
    });
    this.enabled = true;
  }

  /** Wire encryption into an outbound sender. Idempotent per sender. */
  async secureSender(sender: RTCRtpSender): Promise<void> {
    const marked = sender as MarkedSender;
    if (!this.enabled || !sender || marked.__wlkEnc) return;
    await this._ready;
    try {
      const ST = scriptTransformCtor();
      if (ST && 'RTCRtpScriptTransform' in RTCRtpSender.prototype) {
        (marked as unknown as { transform: unknown }).transform = new ST(this._worker, { direction: 'encrypt' });
      } else {
        const { readable, writable } = (sender as unknown as EncodedStreamsSource).createEncodedStreams();
        this._worker.postMessage({ type: 'transform', readable, writable, direction: 'encrypt' },
          [readable, writable] as unknown as Transferable[]);
      }
    } catch (err) {
      this._log(`E2EE SENDER ATTACH FAILED — ${(err as Error)?.message ?? err}`, 'warn');
      throw err; // flags stay unset so callers can log + retry
    }
    marked.__wlkEnc = true;
  }

  /** Wire decryption into an inbound receiver. */
  async secureReceiver(receiver: RTCRtpReceiver): Promise<void> {
    const marked = receiver as MarkedReceiver;
    if (!this.enabled || !receiver || marked.__wlkDec) return;
    await this._ready;
    try {
      const ST = scriptTransformCtor();
      if (ST && 'RTCRtpScriptTransform' in RTCRtpReceiver.prototype) {
        (marked as unknown as { transform: unknown }).transform = new ST(this._worker, { direction: 'decrypt' });
      } else {
        const { readable, writable } = (receiver as unknown as EncodedStreamsSource).createEncodedStreams();
        this._worker.postMessage({ type: 'transform', readable, writable, direction: 'decrypt' },
          [readable, writable] as unknown as Transferable[]);
      }
    } catch (err) {
      this._log(`E2EE RECEIVER ATTACH FAILED — ${(err as Error)?.message ?? err}`, 'warn');
      throw err; // flags stay unset so callers can log + retry
    }
    marked.__wlkDec = true;
  }

  stats(): Promise<E2EEStats> {
    return new Promise((res) => {
      const h = (e: MessageEvent): void => {
        if (e.data?.type === 'stats') { this._worker.removeEventListener('message', h); res(e.data as E2EEStats); }
      };
      this._worker.addEventListener('message', h);
      this._worker.postMessage({ type: 'stats' });
    });
  }

  destroy(): void {
    this.enabled = false;
    this._worker.terminate();
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
