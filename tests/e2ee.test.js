import { describe, it, expect, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { webcrypto } from 'node:crypto';
import { WORKER_SRC } from '../src/security/e2ee.js';

/* Regression harness for the E2EE frame worker (src/security/e2ee.ts).
   WORKER_SRC runs VERBATIM inside node:worker_threads. A prelude maps the
   browser `self` message surface onto parentPort, and an epilogue exposes
   the worker's own encrypt/decrypt/pump to the test via control messages —
   no stream transfer needed: crypto is driven on synthetic
   { data: ArrayBuffer } frames, and the pump runs on streams created
   INSIDE the worker. Real crypto.subtle (Node 22). */

const PRELUDE = `
const { parentPort } = require('worker_threads');
const self = {
  postMessage: (msg) => parentPort.postMessage(msg),
  onmessage: null,
  onrtctransform: null,
};
parentPort.on('message', (data) => {
  const fn = self.onmessage;
  if (typeof fn === 'function') {
    try { fn({ data }); } catch (_) { /* worker handler threw — ignore */ }
  }
});
`;

const EPILOGUE = `
parentPort.on('message', (d) => {
  if (!d || typeof d !== 'object') return;
  if (d.type === 't-encrypt') {
    Promise.resolve()
      .then(() => encrypt({ data: d.buf }))
      .then((out) => parentPort.postMessage({ type: 't-encrypt-ok', id: d.id, buf: out.data }))
      .catch((e) => parentPort.postMessage({ type: 't-encrypt-err', id: d.id, message: String((e && e.message) || e) }));
    return;
  }
  if (d.type === 't-decrypt') {
    Promise.resolve()
      .then(() => decrypt({ data: d.buf }))
      .then((out) => parentPort.postMessage({ type: 't-decrypt-ok', id: d.id, buf: out.data }))
      .catch((e) => parentPort.postMessage({ type: 't-decrypt-err', id: d.id, message: String((e && e.message) || e) }));
    return;
  }
  if (d.type === 't-pump') {
    (async () => {
      try {
        const inputs = Array.isArray(d.bufs) ? d.bufs : [];
        const outputs = [];
        const readable = new ReadableStream({
          start(c) { for (const b of inputs) c.enqueue({ data: b }); c.close(); },
        });
        const writable = new WritableStream({
          write(frame) { outputs.push(frame.data); },
        });
        await pump(readable, writable, d.direction);
        parentPort.postMessage({ type: 't-pump-ok', id: d.id, count: outputs.length, bufs: outputs });
      } catch (e) {
        parentPort.postMessage({ type: 't-pump-err', id: d.id, message: String((e && e.message) || e) });
      }
    })();
    return;
  }
});
`;

const workers = [];
let nextId = 1;

function spawn() {
  const w = new Worker(PRELUDE + WORKER_SRC + EPILOGUE, { eval: true });
  workers.push(w);
  /* Behavior assertions (not crashes) are the signal; a dead worker
     surfaces as an rpc timeout below instead of killing the run. */
  w.on('error', () => {});
  return w;
}

afterAll(async () => {
  await Promise.all(workers.map((w) => w.terminate()));
});

function listen(worker, match, timeoutMs, timeoutMsg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMsg);
      reject(new Error(timeoutMsg));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onMsg = (m) => {
      if (match(m)) {
        clearTimeout(timer);
        worker.off('message', onMsg);
        resolve(m);
      }
    };
    worker.on('message', onMsg);
  });
}

async function initWorker(worker, rawKey) {
  const ready = listen(worker, (m) => m && m.type === 'ready', 4000, 'e2ee worker init timeout (no ready)');
  worker.postMessage({ type: 'init', rawKey });
  await ready;
}

/* Sends a t-* control message; resolves with the -ok OR -err reply so
   callers can assert the fail-closed half explicitly. */
async function rpc(worker, msg, okType) {
  const id = nextId++;
  const errType = okType.replace('-ok', '-err');
  const p = listen(
    worker,
    (m) => m && m.id === id && (m.type === okType || m.type === errType),
    4000,
    `e2ee worker timeout waiting for ${okType}`,
  );
  worker.postMessage({ ...msg, id });
  return p;
}

async function getStats(worker) {
  const p = listen(worker, (m) => m && m.type === 'stats', 4000, 'e2ee worker stats timeout');
  worker.postMessage({ type: 'stats' });
  return p;
}

const randomKey = () => webcrypto.getRandomValues(new Uint8Array(32));
const randomFrame = (n) => webcrypto.getRandomValues(new Uint8Array(n));

describe('E2EE worker — frame crypto (WORKER_SRC)', () => {
  it('encrypt→decrypt round-trips byte-identical frames', async () => {
    const w = spawn();
    await initWorker(w, randomKey());
    const plain = randomFrame(64);
    const enc = await rpc(w, { type: 't-encrypt', buf: plain }, 't-encrypt-ok');
    expect(enc.type).toBe('t-encrypt-ok');
    expect(enc.buf.byteLength).toBeGreaterThan(plain.byteLength);
    const dec = await rpc(w, { type: 't-decrypt', buf: enc.buf }, 't-decrypt-ok');
    expect(dec.type).toBe('t-decrypt-ok');
    expect(new Uint8Array(dec.buf)).toEqual(plain);
  });

  it('ciphertext carries exactly 12B IV + 16B GCM tag overhead', async () => {
    const w = spawn();
    await initWorker(w, randomKey());
    const plain = randomFrame(48);
    const enc = await rpc(w, { type: 't-encrypt', buf: plain }, 't-encrypt-ok');
    expect(enc.buf.byteLength).toBe(plain.byteLength + 28);
  });

  it('two encrypts of the same plaintext differ (fresh random IV per frame)', async () => {
    const w = spawn();
    await initWorker(w, randomKey());
    const plain = randomFrame(32);
    const a = await rpc(w, { type: 't-encrypt', buf: plain }, 't-encrypt-ok');
    const b = await rpc(w, { type: 't-encrypt', buf: plain }, 't-encrypt-ok');
    expect([...new Uint8Array(a.buf)]).not.toEqual([...new Uint8Array(b.buf)]);
  });

  it('short frames fail closed: decrypt throws, pump drops + counts, nothing forwarded', async () => {
    const w = spawn();
    await initWorker(w, randomKey());
    const err = await rpc(w, { type: 't-decrypt', buf: new Uint8Array(5).buffer }, 't-decrypt-ok');
    expect(err.type).toBe('t-decrypt-err');
    expect(err.message).toMatch(/short/i);
    const pumped = await rpc(
      w,
      { type: 't-pump', direction: 'decrypt', bufs: [new Uint8Array(5).buffer, new Uint8Array(12).buffer] },
      't-pump-ok',
    );
    expect(pumped.type).toBe('t-pump-ok');
    expect(pumped.count).toBe(0);
    expect(pumped.bufs).toEqual([]);
    const stats = await getStats(w);
    expect(stats.drops).toBe(2);
    expect(stats.decCount).toBe(0);
  });

  it('pre-init frames are dropped, never forwarded in the clear', async () => {
    const w = spawn();   // deliberately never sent init
    const pumped = await rpc(
      w,
      { type: 't-pump', direction: 'encrypt', bufs: [randomFrame(32).buffer] },
      't-pump-ok',
    );
    expect(pumped.type).toBe('t-pump-ok');
    expect(pumped.count).toBe(0);
    const stats = await getStats(w);
    expect(stats.drops).toBe(1);
    expect(stats.encCount).toBe(0);
  });

  it('wrong-key decrypt fails closed (auth error only, no plaintext)', async () => {
    const a = spawn();
    const b = spawn();
    await initWorker(a, randomKey());
    await initWorker(b, randomKey());
    const plain = randomFrame(40);
    const enc = await rpc(a, { type: 't-encrypt', buf: plain }, 't-encrypt-ok');
    const res = await rpc(b, { type: 't-decrypt', buf: enc.buf }, 't-decrypt-ok');
    expect(res.type).toBe('t-decrypt-err');
    expect(res.message).toBeTruthy();
    expect('buf' in res).toBe(false);
  });

  it('no drops telemetry under threshold (E2EE warn log stays silent)', async () => {
    const w = spawn();
    await initWorker(w, randomKey());
    // Mirrors E2EE onmessage mapping: {type:'drops'} → log('FRAME DROPS n — …', 'warn').
    const warns = [];
    const onMsg = (m) => { if (m?.type === 'drops') warns.push({ msg: `FRAME DROPS ${m.drops} — POSSIBLE TAMPER/LOSS`, kind: 'warn' }); };
    w.on('message', onMsg);
    try {
      const pumped = await rpc(
        w,
        { type: 't-pump', direction: 'decrypt', bufs: Array.from({ length: 10 }, () => new Uint8Array(5).buffer) },
        't-pump-ok',
      );
      expect(pumped.count).toBe(0);
      const stats = await getStats(w); // round-trip flush: any drops msg would arrive before stats
      expect(stats.drops).toBe(10);
      expect(warns).toEqual([]);
    } finally {
      w.off('message', onMsg);
    }
  });

  it('drops telemetry fires once crossing 50 (E2EE warn log)', async () => {
    const w = spawn();
    await initWorker(w, randomKey());
    // Mirrors E2EE onmessage mapping: {type:'drops'} → log('FRAME DROPS n — …', 'warn').
    const warns = [];
    const onMsg = (m) => { if (m?.type === 'drops') warns.push({ msg: `FRAME DROPS ${m.drops} — POSSIBLE TAMPER/LOSS`, kind: 'warn' }); };
    w.on('message', onMsg);
    try {
      const pumped = await rpc(
        w,
        { type: 't-pump', direction: 'decrypt', bufs: Array.from({ length: 50 }, () => new Uint8Array(5).buffer) },
        't-pump-ok',
      );
      expect(pumped.count).toBe(0);
      const stats = await getStats(w); // flush: drops msg arrives before stats reply
      expect(stats.drops).toBe(50);
      expect(warns.length).toBe(1); // throttled by construction — only on crossing
      expect(warns[0].kind).toBe('warn');
      expect(warns[0].msg).toContain('50');
    } finally {
      w.off('message', onMsg);
    }
  });
});
