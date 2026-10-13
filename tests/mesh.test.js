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
vi.mock('../src/audio/silentTrack.js', () => ({
  silentStream: vi.fn(() => 'STREAM_SENTINEL'),
  getSilentTrack: vi.fn(() => 'TRACK_SENTINEL'),
  silentContextRunning: vi.fn(() => true),
}));

import { Mesh, onCrypto } from '../src/webrtc/mesh.js';
import { silentStream } from '../src/audio/silentTrack.js';
import { set, state, clearPeers, linkedCount } from '../src/core/state.js';

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

  it('disconnected ICE restarts first, then defers while TX is hot (fake timers)', async () => {
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
        expect(mesh.legs.has('peer-4')).toBe(true);                 // leg kept for the drain
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
