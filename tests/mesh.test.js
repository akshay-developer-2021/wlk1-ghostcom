import { describe, it, expect, vi } from 'vitest';

/* Node-safe mocks: peerjs ships browser globals; silent track is faked */
vi.mock('peerjs', () => ({ Peer: class { destroy() {} on() {} } }));
vi.mock('../src/audio/silentTrack.js', () => ({
  silentStream: () => 'SILENT_TRACK',
  getSilentTrack: () => ({}),
}));

import { Mesh, onCrypto } from '../src/webrtc/mesh.js';

function makeMesh(e2ee = null) {
  const logs = [];
  return { mesh: new Mesh({ log: (m, k) => logs.push([k, m]), e2ee }), logs };
}

function fakeSender() {
  const sender = { track: null, kind: 'audio', replaced: [] };
  sender.replaceTrack = (t) => sender.replaced.push(t);
  return sender;
}
function fakeLeg(slot, sender) {
  return {
    call: { peer: `peer-${slot}`, peerConnection: { getSenders: () => [sender], getReceivers: () => [], addEventListener() {} } },
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
    expect(sender.replaced).toEqual(['SILENT_TRACK']);
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
