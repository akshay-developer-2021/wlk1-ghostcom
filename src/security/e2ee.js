/* ═══════════════════════════════════════════════════════════════
   security/e2ee.js — true end-to-end frame encryption on top of
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
self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'init') {
    key = await crypto.subtle.importKey('raw', d.rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (d.type === 'transform') {
    const { readable, writable, direction } = d;
    const reader = readable.getReader();
    const writer = writable.getWriter();
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
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
    return;
  }
  if (d.type === 'stats') self.postMessage({ type: 'stats', drops, encCount, decCount });
};
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
  frame.data = pt.buffer;
  return frame;
}
`;

export class E2EE {
  /** Capability check — must be called before claiming the E2EE badge. */
  static supported() {
    if (typeof RTCRtpSender === 'undefined') return false;
    return 'RTCRtpScriptTransform' in RTCRtpSender.prototype
      || typeof RTCRtpSender.prototype.createEncodedStreams === 'function';
  }

  /** @param rawKeyBytes Uint8Array(32) — from crypto.deriveGroupKeyRaw() */
  constructor(rawKeyBytes, log = () => {}) {
    if (!E2EE.supported()) throw new Error('E2EE unsupported');
    this._log = log;
    this._worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    this._worker.postMessage({ type: 'init', rawKey: rawKeyBytes }, [rawKeyBytes.buffer]);
    this._ready = new Promise((res) => {
      this._worker.onmessage = (e) => { if (e.data.type === 'ready') res(); };
    });
    this.enabled = true;
  }

  /** Wire encryption into an outbound sender. Idempotent per sender. */
  async secureSender(sender) {
    if (!this.enabled || !sender || sender.__wlkEnc) return;
    sender.__wlkEnc = true;
    await this._ready;
    if ('RTCRtpScriptTransform' in RTCRtpSender.prototype) {
      sender.transform = new RTCRtpScriptTransform(this._worker, { direction: 'encrypt' });
    } else {
      const { readable, writable } = sender.createEncodedStreams();
      this._worker.postMessage({ type: 'transform', readable, writable, direction: 'encrypt' },
        [readable, writable]);
    }
  }

  /** Wire decryption into an inbound receiver. */
  async secureReceiver(receiver) {
    if (!this.enabled || !receiver || receiver.__wlkDec) return;
    receiver.__wlkDec = true;
    await this._ready;
    if ('RTCRtpScriptTransform' in RTCRtpReceiver.prototype) {
      receiver.transform = new RTCRtpScriptTransform(this._worker, { direction: 'decrypt' });
    } else {
      const { readable, writable } = receiver.createEncodedStreams();
      this._worker.postMessage({ type: 'transform', readable, writable, direction: 'decrypt' },
        [readable, writable]);
    }
  }

  stats() {
    return new Promise((res) => {
      const h = (e) => {
        if (e.data?.type === 'stats') { this._worker.removeEventListener('message', h); res(e.data); }
      };
      this._worker.addEventListener('message', h);
      this._worker.postMessage({ type: 'stats' });
    });
  }

  destroy() { this._worker.terminate(); }
}

/** Extractable raw key for the worker path (page-memory secret anyway). */
export async function deriveRawGroupKey(subtle, secret) {
  const enc = new TextEncoder();
  const base = await subtle.importKey('raw', enc.encode(`wlk1-e2ee:${secret.toUpperCase()}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('wlk1-salt-v1'), iterations: 120_000, hash: 'SHA-256' },
    base, 256,
  );
  return new Uint8Array(bits);
}
