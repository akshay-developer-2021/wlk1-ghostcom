import { describe, it, expect, vi, afterEach } from 'vitest';

/* Node-safe mocks: peerjs ships browser globals; silent track is faked.
   Distinct sentinels: silentStream feeds outbound dials, getSilentTrack
   feeds the endTx hot-swap — conflating them hid endTx regressions. */
const peerCtl = vi.hoisted(() => ({ onCreate: null }));
vi.mock('peerjs', () => ({
  Peer: class {
    constructor(id, _opts) {
      this.id = id;
      this.handlers = {};
      this.destroyed = false;
      peerCtl.onCreate?.(id, this);
    }
    on(ev, cb) {
      (this.handlers[ev] ??= []).push(cb);
      return this;
    }
    destroy() { this.destroyed = true; }
  },
}));
vi.mock('../src/domain/audio/silentTrack.js', () => ({
  silentStream: vi.fn(() => 'STREAM_SENTINEL'),
  getSilentTrack: vi.fn(() => 'TRACK_SENTINEL'),
  silentContextRunning: vi.fn(() => true),
}));

import { Mesh, onCrypto } from '../src/domain/mesh/mesh.js';
import { silentStream } from '../src/domain/audio/silentTrack.js';
import { set, state, clearPeers, linkedCount } from '../src/domain/state/state.js';

function makeMesh(e2ee = null) {
  const logs = [];
  return { mesh: new Mesh({ log: (m, k) => logs.push([k, m]), e2ee }), logs };
}

function fakeSender() {
  const sender = { track: null, kind: 'audio', replaced: [] };
  sender.replaceTrack = (t) => sender.replaced.push(t);
  return sender;
}
function fakeCall(peerId, sender) {
  const handlers = {};
  const pcHandlers = {};
  const pc = {
    connectionState: 'connected',
    getSenders: () => (sender ? [sender] : []),
    getReceivers: () => [],
    addEventListener(ev, cb) { (pcHandlers[ev] ??= []).push(cb); },
    removeEventListener(ev, cb) {
      const list = pcHandlers[ev];
      if (list) pcHandlers[ev] = list.filter((h) => h !== cb);
    },
    restartIce: vi.fn(),
  };
  return {
    peer: peerId,
    peerConnection: pc,
    handlers,
    pcHandlers,
    close: vi.fn(),
    on(ev, cb) { (handlers[ev] ??= []).push(cb); },
    fire(ev, ...args) { for (const cb of handlers[ev] ?? []) cb(...args); },
    firePc(ev, ...args) { for (const cb of pcHandlers[ev] ?? []) cb(...args); },
  };
}
function fakePeer() {
  const handlers = {};
  return {
    handlers,
    destroyed: false,
    on(ev, cb) { (handlers[ev] ??= []).push(cb); },
    fire(ev, ...args) { for (const cb of handlers[ev] ?? []) cb(...args); },
  };
}
function fakeLeg(slot, sender) {
  return {
    call: fakeCall(`peer-${slot}`, sender),
    slot, mode: 'listen', crypto: null,
  };
}

describe('Mesh lifecycle guards', () => {
  it('destroy() sets the destroyed flag and it STAYS set (regression: neutered flag)', () => {
    const { mesh } = makeMesh();
    mesh.destroy();
    expect(mesh._destroyed).toBe(true);
  });

  it('destroy() tears down peer and legs', () => {
    const { mesh } = makeMesh();
    mesh.legs.set('p1', fakeLeg(1, fakeSender()));
    mesh.destroy();
    expect(mesh.legs.size).toBe(0);
    expect(mesh.peer).toBeNull();
  });

  it('plain leave() resets the flag (normal channel change)', () => {
    const { mesh } = makeMesh();
    mesh.destroy();
    mesh.leave();
    expect(mesh._destroyed).toBe(false);
  });
});

describe('endTx — legs keep sending silence', () => {
  it('replaces the live track with the SHARED SILENT TRACK, not null', async () => {
    const { mesh } = makeMesh();
    const sender = fakeSender();
    mesh.legs.set('peer-3', fakeLeg(3, sender));
    mesh.endTx();
    expect(sender.replaced).toEqual(['TRACK_SENTINEL']);
  });

  it('endTx with no legs is a no-op', () => {
    const { mesh } = makeMesh();
    expect(() => mesh.endTx()).not.toThrow();
  });
});

describe('E2EE capability negotiation', () => {
  it('settle(true) without an E2EE engine stays SRTP (capability gated on engine)', () => {
    const { mesh, logs } = makeMesh(null);           // browser without transforms
    const leg = fakeLeg(2, fakeSender());
    mesh.legs.set('peer-2', leg);
    mesh._settleCrypto(leg, true);                    // remote says "I support E2EE"
    expect(leg.crypto).toBe(false);                   // but we cannot encrypt → SRTP leg
    expect(logs.some(([, m]) => m.includes('SRTP LEG'))).toBe(true);
  });

  it('settle(true) with an engine arms encryption and reports e2ee', async () => {
    const e2ee = { secureSender: vi.fn().mockResolvedValue(), secureReceiver: vi.fn().mockResolvedValue() };
    const { mesh } = makeMesh(e2ee);
    const leg = fakeLeg(2, fakeSender());
    mesh.legs.set('peer-2', leg);
    const statuses = [];
    onCrypto((s) => statuses.push(s));
    mesh._settleCrypto(leg, true);
    await new Promise((r) => setTimeout(r, 0));   // arm attaches async
    expect(leg.crypto).toBe(true);
    expect(e2ee.secureSender).toHaveBeenCalled();
    expect(statuses).toContain('e2ee');
    mesh.leave();
  });

  it('settle(false) marks the leg SRTP — no silent audio drop', () => {
    const e2ee = { secureSender: vi.fn(), secureReceiver: vi.fn() };
    const { mesh } = makeMesh(e2ee);
    const leg = fakeLeg(1, fakeSender());
    mesh.legs.set('peer-1', leg);
    mesh._settleCrypto(leg, false, 'peer lacks transforms');
    expect(leg.crypto).toBe(false);
    expect(e2ee.secureSender).not.toHaveBeenCalled();   // never garble their audio
  });

  it('mixed room → "mixed" status, not a lying "e2ee" badge', async () => {
    const e2ee = { secureSender: vi.fn().mockResolvedValue(), secureReceiver: vi.fn().mockResolvedValue() };
    const { mesh } = makeMesh(e2ee);
    const a = fakeLeg(0, fakeSender());
    const b = fakeLeg(1, fakeSender());
    mesh.legs.set('peer-0', a);
    mesh.legs.set('peer-1', b);
    const statuses = [];
    onCrypto((s) => statuses.push(s));
    mesh._settleCrypto(a, true);
    mesh._settleCrypto(b, false);
    await new Promise((r) => setTimeout(r, 0));   // arm attaches async
    expect(statuses[statuses.length - 1]).toBe('mixed');
    mesh.leave();
  });
});

/* New tests below mutate the shared state store (secret/tx/peers) — reset
   it after every test so existing tests stay green by construction. */
afterEach(() => {
  clearPeers();
  set({ tx: false, secret: null });
});

describe('beginTx — recvonly legs are redialed live', () => {
  it('closes the bare leg and redials it with the live mic stream', async () => {
    const prevSecret = state.secret;
    set({ secret: 'ABC234DEFGHJKLMN' });
    try {
      const { mesh } = makeMesh();
      const sender = fakeSender();
      const leg = fakeLeg(1, sender);
      leg.recvonly = true;                       // answered bare pre-gesture
      mesh.legs.set('peer-1', leg);
      const live = { id: 'live-mic-stream' };
      mesh.peer = {
        destroyed: false,
        call: vi.fn((id) => fakeCall(id, null)),
      };
      mesh.mic = { stream: live };
      mesh.channel = '22';

      const report = await mesh.beginTx({ kind: 'audio' });

      expect(leg.call.close).toHaveBeenCalledTimes(1);   // bare leg torn down
      expect(mesh.legs.has('peer-1')).toBe(false);
      expect(report).toEqual({ attached: 0, redialed: 1 });
      expect(mesh.peer.call).toHaveBeenCalledTimes(1);
      expect(mesh.peer.call.mock.calls[0][1]).toBe(live); // redial carries mic
      const newId = mesh.peer.call.mock.calls[0][0];
      expect(mesh.legs.get(newId)).toMatchObject({ slot: 1, mode: 'live' });
      mesh.leave();
    } finally {
      set({ secret: prevSecret });
    }
  });
});

describe('beginTx — empty-legs first-tap sweep mirrors watchdog zero-leg rule', () => {
  it('fresh solo slot-0 with empty seen stays SOLO — no spray', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    try {
      const { mesh } = makeMesh();
      mesh.peer = { destroyed: false, call: vi.fn((id) => fakeCall(id, null)) };
      mesh.mic = { stream: { id: 'live-mic-stream' } };
      mesh.channel = '22';
      mesh.slot = 0;
      expect(mesh._seenPeers.size).toBe(0);

      const report = await mesh.beginTx({ kind: 'audio' });

      expect(mesh.peer.call).not.toHaveBeenCalled();
      expect(report).toEqual({ attached: 0, redialed: 0 });
      mesh.leave();
    } finally {
      set({ secret: null });
    }
  });

  it('seen-gate blocks slot>0 fresh with no memory too', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    try {
      const { mesh } = makeMesh();
      mesh.peer = { destroyed: false, call: vi.fn((id) => fakeCall(id, null)) };
      mesh.mic = { stream: { id: 'live-mic-stream' } };
      mesh.channel = '22';
      mesh.slot = 2;
      expect(mesh._seenPeers.size).toBe(0);

      const report = await mesh.beginTx({ kind: 'audio' });

      expect(mesh.peer.call).not.toHaveBeenCalled();
      expect(report).toEqual({ attached: 0, redialed: 0 });
      mesh.leave();
    } finally {
      set({ secret: null });
    }
  });

  it('slot-0 rejoiner with faces dials all unlinked non-self slots live; parked stays parked', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    const { mesh } = makeMesh();
    const prevMax = mesh.cfg.maxSlots;
    mesh.cfg.maxSlots = 3;
    try {
      const live = { id: 'live-mic-stream' };
      mesh.peer = { destroyed: false, call: vi.fn((id) => fakeCall(id, null)) };
      mesh.mic = { stream: live };
      mesh.channel = '22';
      mesh.slot = 0;
      mesh._seenPeers.add(1);
      mesh._seenPeers.add(2);
      mesh._dialFails.set(1, 3);                       // parked — TX must not unpark

      const report = await mesh.beginTx({ kind: 'audio' });

      expect(mesh.peer.call).toHaveBeenCalledTimes(1); // only slot 2, slot 1 skipped
      expect(report).toEqual({ attached: 0, redialed: 1 });
      expect(mesh.peer.call.mock.calls[0][1]).toBe(live);
      mesh.leave();
    } finally {
      mesh.cfg.maxSlots = prevMax;
      set({ secret: null });
    }
  });
});

describe('leg close — stale-event guard (close-identity)', () => {
  it('a replaced leg cannot kill its replacement', () => {
    const { mesh } = makeMesh();
    const callA = fakeCall('peer-9', fakeSender());
    mesh._registerLeg(callA, 4, 'listen');
    const callB = fakeCall('peer-9', fakeSender());
    mesh._registerLeg(callB, 4, 'listen');       // same id replaces A

    callA.fire('close');                         // stale event from replaced A
    expect(mesh.legs.get('peer-9')?.call).toBe(callB);   // B survives
    expect(mesh.legs.size).toBe(1);

    callB.fire('close');                         // the live leg really dropping cleans up
    expect(mesh.legs.size).toBe(0);
    mesh.leave();
  });
});

describe('crypto dataconn close — the cross-browser departure signal', () => {
  function fakeConn(peerId) {
    const handlers = {};
    return {
      peer: peerId,
      open: true,
      handlers,
      on(ev, cb) { (handlers[ev] ??= []).push(cb); },
      send: () => {},
      close: () => {},
      fire(ev, ...args) { for (const cb of handlers[ev] ?? []) cb(...args); },
    };
  }

  it('a closed crypto dataconn tears down the live leg (WebKit remote destroy)', () => {
    const { mesh } = makeMesh();
    const call = fakeCall('peer-4', fakeSender());
    mesh._registerLeg(call, 4, 'listen');
    const leg = mesh.legs.get('peer-4');
    clearTimeout(leg._cryptoTimer);
    const conn = fakeConn('peer-4');
    mesh._dataConns.set('peer-4', conn);
    mesh._wireCryptoConn(conn, leg);

    conn.fire('close');                          // remote destroyed itself
    expect(mesh.legs.has('peer-4')).toBe(false);
    expect(mesh._dataConns.has('peer-4')).toBe(false);
    expect(linkedCount()).toBe(0);               // chip + LNK go honest
    expect(call.close).toHaveBeenCalled();       // the media leg is actually closed
    mesh.leave();
  });

  it('the wiring leg only dies while it is still current — a replacement survives', () => {
    const { mesh, logs } = makeMesh();
    const conn = fakeConn('peer-9');
    mesh._dataConns.set('peer-9', conn);
    const callA = fakeCall('peer-9', fakeSender());
    mesh._registerLeg(callA, 4, 'listen');
    mesh._wireCryptoConn(conn, mesh.legs.get('peer-9'));
    const callB = fakeCall('peer-9', fakeSender());
    mesh._registerLeg(callB, 4, 'listen');       // same id replaces A
    mesh._wireCryptoConn(conn, mesh.legs.get('peer-9'));

    conn.fire('close');                          // A's stale listener + B's live listener both run
    expect(mesh.legs.has('peer-9')).toBe(false); // B dropped exactly once by its own wiring
    expect(logs.filter(([, m]) => m.includes('LINK DROPPED')).length).toBe(1);
    mesh.leave();
  });

  it('a wire-level BYE tears the leg down without any close event', () => {
    const { mesh } = makeMesh();
    const call = fakeCall('peer-4', fakeSender());
    mesh._registerLeg(call, 4, 'listen');
    const leg = mesh.legs.get('peer-4');
    clearTimeout(leg._cryptoTimer);
    const conn = fakeConn('peer-4');
    mesh._dataConns.set('peer-4', conn);
    mesh._wireCryptoConn(conn, leg);

    conn.fire('data', { t: 'wlk1-bye' });
    expect(mesh.legs.has('peer-4')).toBe(false);
    expect(mesh._dataConns.has('peer-4')).toBe(false);
    expect(linkedCount()).toBe(0);
    expect(call.close).toHaveBeenCalled();
    mesh.leave();
  });

  it('leave() broadcasts BYE on every open dataconn before closing them', () => {
    const { mesh } = makeMesh();
    const call = fakeCall('peer-4', fakeSender());
    mesh._registerLeg(call, 4, 'listen');
    clearTimeout(mesh.legs.get('peer-4')._cryptoTimer);
    const sent = [];
    const conn = { ...fakeConn('peer-4'), send: (m) => sent.push(m) };
    mesh._dataConns.set('peer-4', conn);
    mesh._wireCryptoConn(conn, mesh.legs.get('peer-4'));

    mesh.leave();
    expect(sent.some((m) => { try { return JSON.parse(m).t === 'wlk1-bye'; } catch { return false; } })).toBe(true);
    expect(mesh.legs.size).toBe(0);
  });
});

describe('socket-open wedge recovery — redial seen peers with zero live legs', () => {
  it('a stranded radio redials its seen peers the moment the signal is back', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    const { mesh } = makeMesh();
    const prevMax = mesh.cfg.maxSlots;
    mesh.cfg.maxSlots = 3;
    try {
      const live = { id: 'live-mic-stream' };
      mesh.peer = { destroyed: false, call: vi.fn((id) => fakeCall(id, null)) };
      mesh.mic = { stream: live };
      mesh.channel = '22';
      mesh.slot = 0;
      mesh._seenPeers.add(2);
      mesh._dialFails.set(1, 3);                       // parked stays parked

      await mesh._redialSeenPeers();

      expect(mesh.peer.call).toHaveBeenCalledTimes(1); // slot 2 rediscovered
      expect(mesh.peer.call.mock.calls[0][1]).toBe(live);
      expect(mesh.legs.size).toBe(1);
      mesh.leave();
    } finally {
      mesh.cfg.maxSlots = prevMax;
      set({ secret: null });
    }
  });

  it('a radio with live legs stays silent (no spray behind an existing link)', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    const { mesh } = makeMesh();
    try {
      mesh.peer = { destroyed: false, call: vi.fn() };
      mesh.mic = { stream: { id: 'live' } };
      mesh.channel = '22';
      mesh.slot = 0;
      mesh._seenPeers.add(2);
      mesh._registerLeg(fakeCall('peer-2', fakeSender()), 2, 'listen');

      await mesh._redialSeenPeers();

      expect(mesh.peer.call).not.toHaveBeenCalled();
      mesh.leave();
    } finally {
      set({ secret: null });
    }
  });
});

describe('ICE failure mid-TX — redial deferred, drained on endTx', () => {
  it('failed during TX parks the slot in pendingRedial; endTx drains it', () => {
    const { mesh } = makeMesh();
    const call = fakeCall('peer-3', fakeSender());
    mesh._registerLeg(call, 1, 'listen');
    set({ tx: true });
    try {
      call.peerConnection.connectionState = 'failed';
      call.firePc('connectionstatechange');
      expect(call.close).toHaveBeenCalledTimes(1);
      expect(mesh.legs.has('peer-3')).toBe(false);
      expect(mesh._pendingRedial.has(1)).toBe(true);   // parked, air untouched

      mesh.peer = { destroyed: false };
      mesh.slot = 2;
      const dialSpy = vi.spyOn(mesh, '_dialListen').mockImplementation(() => {});
      try {
        mesh.endTx();
        expect(dialSpy).toHaveBeenCalledWith(1);       // drained after TX
        expect(mesh._pendingRedial.size).toBe(0);
      } finally {
        dialSpy.mockRestore();
      }
    } finally {
      set({ tx: false });
    }
    mesh.leave();
  });

  it('disconnected ICE restarts first; a stuck leg retires and its redial defers (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const { mesh } = makeMesh();
      const call = fakeCall('peer-4', fakeSender());
      mesh._registerLeg(call, 2, 'listen');
      set({ tx: true });
      try {
        call.peerConnection.connectionState = 'disconnected';
        call.firePc('connectionstatechange');
        expect(call.peerConnection.restartIce).toHaveBeenCalled();  // transient first
        expect(mesh._pendingRedial.has(2)).toBe(false);             // still in grace window
        await vi.advanceTimersByTimeAsync(5000);                    // stuck past the window
        expect(mesh._pendingRedial.has(2)).toBe(true);              // deferred until TX end
        /* Retired, not kept: _dialListen short-circuits while a leg still
           holds the peer id, so a leg parked "for the drain" would have
           blocked the very redial it was waiting for. */
        expect(mesh.legs.has('peer-4')).toBe(false);
      } finally {
        set({ tx: false });
      }
      mesh.leave();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('peer-unavailable — 3-strike ghost eviction', () => {
  it('misses 1–2 keep the slot, the 3rd consecutive miss evicts it', () => {
    const { mesh, logs } = makeMesh();
    const peer = fakePeer();
    mesh._wirePeer(peer);
    const miss = () => peer.fire('error', { type: 'peer-unavailable', message: 'Could not connect to peer peer-5' });
    const seat = () => {   // redial re-seats the leg between misses
      mesh.legs.set('peer-5', { call: { peer: 'peer-5' }, slot: 5, mode: 'listen', crypto: null });
      mesh.knownOccupied.add(5);
    };

    seat(); miss();
    expect(mesh.legs.has('peer-5')).toBe(false);        // dead leg always reaped
    expect(mesh.knownOccupied.has(5)).toBe(true);       // lone miss = broker race
    expect(logs.some(([, m]) => m.includes('MISS 1/3'))).toBe(true);

    seat(); miss();
    expect(mesh.knownOccupied.has(5)).toBe(true);
    expect(logs.some(([, m]) => m.includes('MISS 2/3'))).toBe(true);

    seat(); miss();
    expect(mesh.knownOccupied.has(5)).toBe(false);      // departed after 3 in a row
    expect(logs.some(([, m]) => m.includes('EVICTED AFTER 3 MISSES'))).toBe(true);
    mesh.leave();
  });
});

describe('join — already-joined fast path', () => {
  it('returns { ok: true, slot } instead of undefined', async () => {
    const { mesh } = makeMesh();
    mesh.peer = { destroyed: false };
    mesh.channel = '22';
    mesh.slot = 3;
    try {
      const r = await mesh.join('22');
      expect(r).toEqual({ ok: true, slot: 3 });
    } finally {
      mesh.peer = null;
      mesh.channel = null;
      mesh.slot = -1;
      mesh.leave();
    }
  });
});

describe('diagnosis — FULL only if EVERY resolved probe was unavailable-id', () => {
  it('all unavailable-id → full', () => {
    const { mesh } = makeMesh();
    expect(mesh._diagnose([{ result: 'unavailable-id' }, { result: 'unavailable-id' }])).toBe('full');
    mesh.leave();
  });

  it('single unavailable-id → full', () => {
    const { mesh } = makeMesh();
    expect(mesh._diagnose([{ result: 'unavailable-id' }])).toBe('full');
    mesh.leave();
  });

  it('mixed unavailable + network → unreachable', () => {
    const { mesh } = makeMesh();
    expect(mesh._diagnose([{ result: 'unavailable-id' }, { result: 'network' }])).toBe('unreachable');
    mesh.leave();
  });

  it('mixed unavailable + error → unreachable', () => {
    const { mesh } = makeMesh();
    expect(mesh._diagnose([{ result: 'unavailable-id' }, { result: 'error' }])).toBe('unreachable');
    mesh.leave();
  });

  it('all timeouts → unreachable (timeouts count as neither)', () => {
    const { mesh } = makeMesh();
    expect(mesh._diagnose([{ result: 'timeout' }, { result: 'timeout' }])).toBe('unreachable');
    mesh.leave();
  });

  it('unavailable + timeout → full (timeouts ignored)', () => {
    const { mesh } = makeMesh();
    expect(mesh._diagnose([{ result: 'unavailable-id' }, { result: 'timeout' }])).toBe('full');
    mesh.leave();
  });

  it('empty → unreachable', () => {
    const { mesh } = makeMesh();
    expect(mesh._diagnose([])).toBe('unreachable');
    mesh.leave();
  });
});

describe('slot claim — race to FIRST open', () => {
  it('wires the winner immediately without waiting for stragglers; late opens destroyed', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    const { mesh } = makeMesh();
    const prevMax = mesh.cfg.maxSlots;
    const prevProbe = mesh.cfg.slotProbeTimeoutMs;
    mesh.cfg.maxSlots = 3;
    mesh.cfg.slotProbeTimeoutMs = 2000;   // long backstop proves we did not wait
    const created = [];
    peerCtl.onCreate = (id, p) => created.push(p);
    const wireSpy = vi.spyOn(mesh, '_wirePeer');
    try {
      const jp = mesh._join('22');
      await vi.waitFor(() => expect(created.length).toBe(3), { timeout: 2000 });
      for (const cb of created[0].handlers['open'] ?? []) cb();   // first open wins
      await new Promise((r) => setTimeout(r, 20));                // claim microtasks run; stragglers still pending
      expect(wireSpy).toHaveBeenCalledTimes(1);                   // claimed before the 2s backstop
      for (let k = 1; k < created.length; k++) {
        for (const cb of created[k].handlers['error'] ?? []) cb({ type: 'unavailable-id' });
      }
      await new Promise((r) => setTimeout(r, 20));                // straggler destroy microtasks run
      const res = await jp;
      expect(res.ok).toBe(true);
      expect(mesh.peer).toBe(created[0]);
      expect(created[0].destroyed).toBe(false);                   // winner kept
      expect(created[1].destroyed).toBe(true);                    // losers destroyed as they resolve
      expect(created[2].destroyed).toBe(true);
    } finally {
      wireSpy.mockRestore();
      peerCtl.onCreate = null;
      mesh.cfg.maxSlots = prevMax;
      mesh.cfg.slotProbeTimeoutMs = prevProbe;
      mesh.leave();
    }
  });
});

describe('SAS — per-peer prints pruned on leg close', () => {
  it('drops the closed peer entry; SAS reflects current legs only', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    try {
      const e2ee = { secureSender: vi.fn().mockResolvedValue(), secureReceiver: vi.fn().mockResolvedValue() };
      const { mesh } = makeMesh(e2ee);
      const callA = fakeCall('peer-0', fakeSender());
      const callB = fakeCall('peer-1', fakeSender());
      mesh._registerLeg(callA, 0, 'listen');
      mesh._registerLeg(callB, 1, 'listen');
      const pcA = { getStats: async () => new Map([['c1', { type: 'certificate', fingerprint: 'FP-A' }]]) };
      const pcB = { getStats: async () => new Map([['c2', { type: 'certificate', fingerprint: 'FP-B' }]]) };
      await mesh._collectSas(pcA, 'peer-0');
      await mesh._collectSas(pcB, 'peer-1');
      expect(mesh._sasPrints.get('peer-0')).toEqual(new Set(['FP-A']));
      expect(mesh._sasPrints.get('peer-1')).toEqual(new Set(['FP-B']));
      expect(typeof state.sas).toBe('string');                     // union of 2 → code set

      callA.fire('close');                                        // leg close prunes its peer
      expect(mesh._sasPrints.has('peer-0')).toBe(false);
      expect(mesh._sasPrints.has('peer-1')).toBe(true);

      callB.fire('error');                                        // error path prunes too
      expect(mesh._sasPrints.has('peer-1')).toBe(false);
      mesh.leave();
    } finally {
      set({ secret: null, sas: null });
    }
  });

  it('stale prints from non-current legs never join the union', async () => {
    set({ secret: 'ABC234DEFGHJKLMN' });
    try {
      const e2ee = { secureSender: vi.fn().mockResolvedValue(), secureReceiver: vi.fn().mockResolvedValue() };
      const { mesh } = makeMesh(e2ee);
      mesh._sasPrints.set('ghost-peer', new Set(['FP-GHOST']));
      const callB = fakeCall('peer-1', fakeSender());
      mesh._registerLeg(callB, 1, 'listen');
      const pcB = { getStats: async () => new Map([['c2', { type: 'certificate', fingerprint: 'FP-B' }]]) };
      await mesh._collectSas(pcB, 'peer-1');
      expect(state.sas).toBeNull();                               // only 1 current print → threshold holds
      mesh.leave();
    } finally {
      set({ secret: null, sas: null });
    }
  });
});

describe('ghost-redial circuit breaker', () => {
  it('3 consecutive never-connected fires park the slot; PARKED logs once, dials skip, force bypasses', async () => {
    vi.useFakeTimers();
    set({ secret: 'ABC234DEFGHJKLMN' });
    try {
      const { mesh, logs } = makeMesh();
      mesh.channel = '22';
      mesh.slot = 2;
      mesh.peer = { destroyed: false, call: vi.fn((id) => fakeCall(id, fakeSender())) };
      set({ tx: true });   // park the auto-redial so each fire is driven explicitly
      try {
        for (let k = 0; k < 3; k++) {
          const call = fakeCall('peer-1', fakeSender());
          mesh._registerLeg(call, 1, 'listen');
          clearTimeout(mesh.legs.get('peer-1')._cryptoTimer);   // silence handshake noise
          clearTimeout(mesh.legs.get('peer-1')._wireTimer);     // wire-strand timer fires at 8s — not this path
          await vi.advanceTimersByTimeAsync(10_000);            // never-connected fires
        }
      } finally {
        set({ tx: false });
      }
      expect(mesh._dialFails.get(1)).toBe(3);
      expect(logs.filter(([, m]) => m.includes('NEVER-CONNECTED')).length).toBe(3);
      expect(logs.filter(([, m]) => m.includes('UNIT-1 PARKED')).length).toBe(1); // transition only

      mesh.peer.call.mockClear();
      mesh._dialListen(1);                                       // parked — skipped silently
      await vi.advanceTimersByTimeAsync(10);
      expect(mesh.peer.call).not.toHaveBeenCalled();
      expect(logs.filter(([, m]) => m.includes('UNIT-1 PARKED')).length).toBe(1); // no re-log

      /* fake timers never flush the WebCrypto dial chain — finish on real timers */
      vi.useRealTimers();
      silentStream.mockReturnValue({ getAudioTracks: () => [{ kind: 'audio' }] });
      try {
        mesh._dialListen(1, true);                              // slow-lane force bypasses
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        silentStream.mockReturnValue('STREAM_SENTINEL');
      }
      expect(mesh.peer.call).toHaveBeenCalledTimes(1);
      mesh.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ICE failed teardowns count toward parking; PARKED logs once', () => {
    const { mesh, logs } = makeMesh();
    const seat = () => {
      const c = fakeCall('peer-7', fakeSender());
      mesh._registerLeg(c, 7, 'listen');
      const leg = mesh.legs.get('peer-7');
      clearTimeout(leg._cryptoTimer);
      clearTimeout(leg._neverTimer);
      leg._neverTimer = undefined;
      return c;
    };
    for (let k = 0; k < 3; k++) {
      const c = seat();
      c.peerConnection.connectionState = 'failed';
      c.firePc('connectionstatechange');
    }
    expect(mesh._dialFails.get(7)).toBe(3);
    expect(logs.filter(([, m]) => m.includes('UNIT-7 PARKED')).length).toBe(1);
    mesh.leave();
  });

  it('watchdog force-redials parked slots every 4th tick', async () => {
    vi.useFakeTimers();
    set({ secret: 'ABC234DEFGHJKLMN', connected: true });
    try {
      const { mesh } = makeMesh();
      mesh.channel = '22';
      mesh.slot = 3;
      mesh.peer = { destroyed: false };
      mesh.knownOccupied.add(1);
      const keep = fakeCall('peer-0', fakeSender());   // live leg → knownOccupied path
      mesh._registerLeg(keep, 0, 'listen');
      const keepLeg = mesh.legs.get('peer-0');
      clearTimeout(keepLeg._cryptoTimer);
      clearTimeout(keepLeg._neverTimer);
      clearTimeout(keepLeg._wireTimer);
      keepLeg._neverTimer = undefined;
      mesh._dialFails.set(1, 3);                       // parked dead slot
      const seen = [];
      const spy = vi.spyOn(mesh, '_dialListen').mockImplementation((s, f) => { seen.push([s, !!f]); });
      try {
        mesh._startWatchdog();
        for (let t = 0; t < 4; t++) await vi.advanceTimersByTimeAsync(mesh.cfg.watchdogMs);
        expect(seen.filter(([s]) => s === 1).map(([, f]) => f)).toEqual([false, false, false, true]);
      } finally {
        spy.mockRestore();
      }
      mesh.leave();
    } finally {
      set({ connected: false });
      vi.useRealTimers();
    }
  });

  it('remote stream unparks the slot', async () => {
    vi.useFakeTimers();
    set({ secret: 'ABC234DEFGHJKLMN' });
    try {
      const { mesh } = makeMesh();
      mesh.channel = '22';
      mesh.slot = 2;
      mesh.peer = { destroyed: false, call: vi.fn((id) => fakeCall(id, fakeSender())) };
      mesh._dialFails.set(1, 3);                       // parked
      mesh._dialListen(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(mesh.peer.call).not.toHaveBeenCalled();   // still parked

      mesh._onRemoteStream(1, { id: 'remote' });
      expect(mesh._dialFails.get(1)).toBeUndefined();  // proof of life resets
      /* fake timers never flush the WebCrypto dial chain — finish on real timers */
      vi.useRealTimers();
      silentStream.mockReturnValue({ getAudioTracks: () => [{ kind: 'audio' }] });
      try {
        mesh._dialListen(1);
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        silentStream.mockReturnValue('STREAM_SENTINEL');
      }
      expect(mesh.peer.call).toHaveBeenCalledTimes(1);
      mesh.leave();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('linked means media-proven, not dialed', () => {
  it('registering a leg does not light the chip until first media', () => {
    const { mesh } = makeMesh();
    const call = fakeCall('peer-5', fakeSender());
    try {
      mesh._registerLeg(call, 5, 'listen');
      expect(linkedCount()).toBe(0);   // no phantom unit: no entry, no chip
    } finally {
      mesh.leave();
    }
  });

  it('first remote stream lights the chip', () => {
    const { mesh } = makeMesh();
    const call = fakeCall('peer-5', fakeSender());
    try {
      mesh._registerLeg(call, 5, 'listen');
      mesh._onRemoteStream(5, { id: 'remote-stream' });
      expect(state.peers.get(5)?.linked).toBe(true);
    } finally {
      mesh.leave();
    }
  });

  it('glare re-register of a streaming slot stays lit', () => {
    const { mesh } = makeMesh();
    const callA = fakeCall('peer-6', fakeSender());
    mesh._registerLeg(callA, 6, 'listen');
    mesh._onRemoteStream(6, { id: 'remote-stream' });
    const callB = fakeCall('peer-6', fakeSender());
    try {
      mesh._registerLeg(callB, 6, 'listen');            // same id replaces A
      expect(state.peers.get(6)?.linked).toBe(true);    // no flicker
    } finally {
      mesh.leave();
    }
  });
});

describe('seen faces follow room identity (channel+secret)', () => {
  it('same-secret rejoin keeps faces; changed secret forgets them', async () => {
    set({ secret: 'AAAAAAAAAAAAAAAA' });
    const { mesh } = makeMesh();
    const prevMax = mesh.cfg.maxSlots;
    mesh.cfg.maxSlots = 1;
    const created = [];
    peerCtl.onCreate = (id, p) => created.push(p);
    const openProbe = async () => {
      await vi.waitFor(() => expect(created.length).toBe(1), { timeout: 2000 });
      for (const cb of created[0].handlers['open'] ?? []) cb();
    };
    try {
      let jp = mesh._join('22');
      await openProbe();
      expect((await jp).ok).toBe(true);
      mesh._seenPeers.add(3);                           // a face from room life

      created.length = 0;
      jp = mesh._join('22');                            // same room rejoin
      await openProbe();
      await jp;
      expect(mesh._seenPeers.has(3)).toBe(true);        // kept — sweep can heal

      set({ secret: 'BBBBBBBBBBBBBBBB' });
      created.length = 0;
      jp = mesh._join('22');                            // same channel, NEW secret = new room
      await openProbe();
      await jp;
      expect(mesh._seenPeers.size).toBe(0);             // strangers forgotten
    } finally {
      peerCtl.onCreate = null;
      mesh.cfg.maxSlots = prevMax;
      mesh.leave();
    }
  });
});

/* Cross-browser symptom: Brave ↔ Firefox legs looped
   `E2EE UNAVAILABLE (handshake timeout)` → `WIRE NEVER-OPENED — REDIAL`
   forever because BOTH sides dialed a DataChannel over the same peer
   connection and the mirror clobbered the map entry. Exactly one side —
   the media dialer — may connect. */
describe('DataChannel ownership (single dialer per leg pair)', () => {
  function fakeConn(peerId) {
    const handlers = {};
    return {
      peer: peerId, open: false, sent: [], closed: false,
      send(d) { this.sent.push(d); },
      close() { this.closed = true; this.open = false; },
      on(ev, cb) { (handlers[ev] ??= []).push(cb); return this; },
      fire(ev, ...args) { for (const cb of handlers[ev] ?? []) cb(...args); },
    };
  }

  it('the leg owner dials exactly one channel', () => {
    const { mesh } = makeMesh();
    const dc = fakeConn('peer-4');
    mesh.peer = { ...fakePeer(), connect: vi.fn(() => dc) };
    mesh._registerLeg(fakeCall('peer-4', fakeSender()), 4, 'listen');
    expect(mesh.peer.connect).toHaveBeenCalledTimes(1);
    expect(mesh._dataConns.get('peer-4')).toBe(dc);
    mesh.leave();
  });

  it('the answered side never dials — it waits for the inbound channel', () => {
    const { mesh } = makeMesh();
    mesh.peer = { ...fakePeer(), connect: vi.fn(() => fakeConn('peer-4')) };
    const call = fakeCall('peer-4', fakeSender());
    mesh._registerLeg(call, 4, 'listen', false);       // inbound leg → not owner
    expect(mesh.peer.connect).not.toHaveBeenCalled();
    /* its timers stay armed while it waits for the owner to dial */
    const leg = mesh.legs.get('peer-4');
    expect(leg._cryptoTimer).toBeDefined();
    expect(leg._wireTimer).toBeDefined();

    const dc = fakeConn('peer-4');
    mesh._onDataConn(dc);
    dc.fire('open');
    expect(leg._wireOpen).toBe(true);
    expect(JSON.parse(dc.sent[0])).toMatchObject({ t: 'wlk1-hello' });
    dc.fire('data', { t: 'wlk1-ack', e2ee: false });    // handshake completes
    expect(leg.crypto).toBe(false);                    // honest: no transforms
    mesh.leave();
  });

  /* WebKit rejects a DataChannel.send() of anything but text/blob/binary with
     "Error sending binary data through RTCDataChannel", which surfaced as an
     uncaught page error that killed a three-peer session. Every message goes
     out as JSON text. */
  it('every wire message is sent as JSON text, never a raw object', () => {
    const { mesh } = makeMesh();
    const conn = fakeConn('peer-4');
    mesh._dataConns.set('peer-4', conn);
    mesh._registerLeg(fakeCall('peer-4', fakeSender()), 4, 'listen');
    mesh._wireCryptoConn(conn, mesh.legs.get('peer-4'));

    conn.fire('open');
    conn.open = true;                       // presence only rides an open channel
    conn.fire('data', JSON.stringify({ t: 'wlk1-hello', e2ee: true }));
    mesh.sendSpeaking(true);
    mesh.leave();

    expect(conn.sent.length).toBeGreaterThan(1);
    for (const msg of conn.sent) {
      expect(typeof msg, `sent a ${typeof msg}, not text`).toBe('string');
      expect(() => JSON.parse(msg)).not.toThrow();
    }
    /* registration already wires the channel, so ordering across handlers is
       not the claim here — the message TYPES are. */
    const kinds = conn.sent.map((m) => JSON.parse(m).t);
    expect(kinds).toContain('wlk1-hello');
    expect(kinds).toContain('wlk1-ack');
    expect(kinds).toContain('wlk1-speaking');
  });

  it('a competing channel never wins by arriving first — the opener wins', () => {
    const { mesh } = makeMesh();
    const ours = fakeConn('peer-4');
    mesh.peer = { ...fakePeer(), connect: vi.fn(() => ours) };
    mesh._registerLeg(fakeCall('peer-4', fakeSender()), 4, 'listen');

    const mirror = fakeConn('peer-4');
    mesh._onDataConn(mirror);                          // peer dialed back
    /* NEITHER is closed yet: on WebKit the self-dial never opens, so
       closing on arrival kills the only working channel. */
    expect(mirror.closed).toBe(false);
    expect(ours.closed).toBe(false);

    mirror.open = true;
    mirror.fire('open');                               // the one that opened
    expect(mirror.closed).toBe(false);                 // promoted
    expect(ours.closed).toBe(true);                    // loser closed
    expect(mesh._dataConns.get('peer-4')).toBe(mirror);
    mesh.leave();
  });

  it('the owner adopts an inbound channel instead of dialing over it', () => {
    const { mesh } = makeMesh();
    mesh.peer = { ...fakePeer(), connect: vi.fn(() => fakeConn('peer-4')) };
    const dc = fakeConn('peer-4');
    mesh._dataConns.set('peer-4', dc);                  // landed first (glare)
    mesh._registerLeg(fakeCall('peer-4', fakeSender()), 4, 'listen');
    expect(mesh.peer.connect).not.toHaveBeenCalled();   // no second channel
    dc.fire('open');
    expect(mesh.legs.get('peer-4')._wireOpen).toBe(true);
    mesh.leave();
  });
});

describe('E2EE transform timing (armed at leg creation)', () => {
  /* secureSender/secureReceiver resolve TRUE when frames are genuinely
     transformed — the mesh advertises that answer to the peer. */
  const e2eeMock = () => ({
    secureSender: vi.fn().mockResolvedValue(true),
    secureReceiver: vi.fn().mockResolvedValue(true),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const openConn = (peerId) => ({ peer: peerId, open: true, on: () => {}, send: () => {}, close: () => {} });

  it('wires the outbound transform when the leg is registered, not after the handshake', async () => {
    const e2ee = e2eeMock();
    const { mesh } = makeMesh(e2ee);
    const sender = fakeSender();
    try {
      mesh._registerLeg(fakeCall('peer-0', sender), 0, 'listen');
      /* Chromium ignores a transform assigned once the sender has started
         sending (measured: onrtctransform never fires), so the attach must
         not wait for the capability handshake. */
      expect(e2ee.secureSender).toHaveBeenCalledWith(sender);
      await flush();                       // the flag follows the attach result
      expect(mesh.legs.get('peer-0')._cryptoArmed).toBe(true);
    } finally {
      mesh.leave();
    }
  });

  /* The advertisement is the whole point: a peer that cannot attach must say
     so, or the other end keeps its decryptor armed and discards every frame
     we send in the clear (measured: dec=0 with decDrops on every frame). */
  it('advertises plaintext when the transform cannot be attached', async () => {
    const e2ee = { secureSender: vi.fn().mockResolvedValue(false), secureReceiver: vi.fn().mockResolvedValue(true) };
    const { mesh } = makeMesh(e2ee);
    const sent = [];
    const handlers = {};
    const conn = {
      peer: 'peer-0', open: false,
      on: (ev, fn) => { handlers[ev] = fn; },
      fire: (ev, d) => handlers[ev]?.(d),
      send: (m) => sent.push(m),
      close: () => {},
    };
    try {
      mesh._registerLeg(fakeCall('peer-0', fakeSender()), 0, 'listen');
      await flush();
      const leg = mesh.legs.get('peer-0');
      expect(leg._cryptoArmed).toBe(false);
      mesh._wireCryptoConn(conn, leg);
      conn.fire('open');
      expect(JSON.parse(sent[0]).e2ee).toBe(false);
    } finally {
      mesh.leave();
    }
  });

  it('arms a receiver that already exists (the answerer gets it before answer() returns)', () => {
    const e2ee = e2eeMock();
    const { mesh } = makeMesh(e2ee);
    const receiver = { track: { kind: 'audio' } };
    const call = fakeCall('peer-0', fakeSender());
    call.peerConnection.getReceivers = () => [receiver];
    try {
      mesh._registerLeg(call, 0, 'listen', false);
      expect(e2ee.secureReceiver).toHaveBeenCalledWith(receiver);
      call.firePc('track', { receiver });               // dialer side: arrives later
      expect(e2ee.secureReceiver).toHaveBeenCalledTimes(2);
    } finally {
      mesh.leave();
    }
  });

  it('a peer that answers without E2EE gets the leg rebuilt untransformed', async () => {
    const e2ee = e2eeMock();
    const { mesh } = makeMesh(e2ee);
    try {
      mesh._registerLeg(fakeCall('peer-1', fakeSender()), 0, 'listen');
      expect(e2ee.secureSender).toHaveBeenCalledTimes(1);
      await flush();                       // armed, so the rebuild path applies

      mesh._settleCrypto(mesh.legs.get('peer-1'), false, 'peer lacks transforms');
      expect(mesh.legs.has('peer-1')).toBe(false);      // an encrypted leg it cannot read is useless

      const rebuilt = mesh._registerLeg(fakeCall('peer-1', fakeSender()), 0, 'listen');
      expect(rebuilt._cryptoArmed).toBeFalsy();        // no transform to a peer without transforms
      expect(e2ee.secureSender).toHaveBeenCalledTimes(1);
    } finally {
      mesh.leave();
    }
  });

  it('a handshake that merely never completed does not condemn the peer', () => {
    const e2ee = e2eeMock();
    const { mesh } = makeMesh(e2ee);
    try {
      mesh._registerLeg(fakeCall('peer-2', fakeSender()), 0, 'listen');
      mesh._settleCrypto(mesh.legs.get('peer-2'), false, 'handshake timeout');
      expect(mesh.legs.has('peer-2')).toBe(true);       // leg survives, plain SRTP
      expect(mesh.legs.get('peer-2').crypto).toBe(false);
    } finally {
      mesh.leave();
    }
  });
});
