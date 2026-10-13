import { describe, it, expect, vi, afterEach } from 'vitest';

/* Node-safe mocks: peerjs ships browser globals; silent track is faked.
   Distinct sentinels: silentStream feeds outbound dials, getSilentTrack
   feeds the endTx hot-swap — conflating them hid endTx regressions. */
vi.mock('peerjs', () => ({ Peer: class { destroy() {} on() {} } }));
vi.mock('../src/audio/silentTrack.js', () => ({
  silentStream: () => 'STREAM_SENTINEL',
  getSilentTrack: () => 'TRACK_SENTINEL',
}));

import { Mesh, onCrypto } from '../src/webrtc/mesh.js';
import { set, state, clearPeers } from '../src/core/state.js';

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

  it('settle(true) with an engine arms encryption and reports e2ee', () => {
    const e2ee = { secureSender: vi.fn().mockResolvedValue(), secureReceiver: vi.fn().mockResolvedValue() };
    const { mesh } = makeMesh(e2ee);
    const leg = fakeLeg(2, fakeSender());
    mesh.legs.set('peer-2', leg);
    const statuses = [];
    onCrypto((s) => statuses.push(s));
    mesh._settleCrypto(leg, true);
    expect(leg.crypto).toBe(true);
    expect(e2ee.secureSender).toHaveBeenCalled();
    expect(statuses).toContain('e2ee');
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

  it('mixed room → "mixed" status, not a lying "e2ee" badge', () => {
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
    expect(statuses[statuses.length - 1]).toBe('mixed');
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
