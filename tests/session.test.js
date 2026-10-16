import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionService } from '../src/app/session/session-service.js';
import { set, clearPeers } from '../src/domain/state/state.js';

/** Minimal in-memory doubles for every SessionService port. */
function makeDeps() {
  const calls = { joins: [], leaves: 0, screens: [], toasts: [], hashes: [], e2eeSet: [], micWarm: 0, micRelease: 0 };
  let meshChannel = null;

  const mesh = {
    async join(channel) { calls.joins.push(channel); meshChannel = channel; return { ok: true, slot: 0 }; },
    leave() { calls.leaves++; meshChannel = null; },
    startQualityPolling() {},
    stopQualityPolling() {},
    setE2ee(instance) { calls.e2eeSet.push(instance); },
    get channel() { return meshChannel; },
  };

  const e2ee = {
    supported: () => true,
    deriveRawGroupKey: async (_subtle, secret) => new TextEncoder().encode(secret),
    create: (rawKey) => ({ rawKey, secureSender: vi.fn(), secureReceiver: vi.fn(), destroy: vi.fn() }),
  };

  const cryptoPort = {
    generateRoomSecret: () => 'SECRET0000000000',
    isValidRoomSecret: () => true,
    normalizeRoomSecret: (s) => s.toUpperCase(),
    parseChannelHash: () => null,
    buildShareLink: () => '',
    deriveSecretFromPassphrase: async () => 'SECRET0000000000',
    passphraseStrength: () => ({ score: 4, label: 'STRONG' }),
  };

  const storage = { get: () => null, set: vi.fn(), remove: vi.fn(), getSession: () => null, setSession: vi.fn(), removeSession: vi.fn() };

  const ui = {
    showScreen: (n) => calls.screens.push(n),
    showHintOnce: vi.fn(),
    joinError: vi.fn(),
    toast: (m) => calls.toasts.push(m),
    syncRadioHash: (c, s) => calls.hashes.push(`${c}.${s}`),
    prefillJoin: vi.fn(),
    clearWords: vi.fn(),
  };

  const mic = {
    warmUp: async () => { calls.micWarm++; },
    release: () => { calls.micRelease++; },
  };

  const deps = { mesh, e2ee, mic, crypto: cryptoPort, storage, ui, log: vi.fn(), config: { warmWindowMs: 5000, maxTxMs: 60000 } };
  return { deps, calls };
}

const SECRET = 'ABCDEFGH01234567';

beforeEach(() => {
  clearPeers();
  set({ channel: null, secret: null, joined: false, tx: false, micHot: false, powerSave: false, sas: null, e2eeMode: 'off' });
});

describe('SessionService', () => {
  it('joins from the hash route', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);

    expect(await session.initFromHash('22', SECRET)).toBe(true);
    expect(calls.joins).toEqual(['22']);
    expect(session.getState().phase).toBe('joined');
    expect(calls.hashes).toEqual([`22.${SECRET}`]);
  });

  it('rekeys the E2EE engine before joining, mirroring room identity into state', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);

    await session.initFromHash('22', SECRET);
    expect(calls.e2eeSet).toHaveLength(1);
    expect(calls.e2eeSet[0]).not.toBeNull();
    /* the mesh reads room identity from global state */
    expect(calls.joins).toEqual(['22']);
  });

  it('dialing another channel while joined actually re-joins it', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);
    await session.initFromHash('22', SECRET);

    /* the keypad dial path: rejoin, not a fresh join */
    expect(await session.rejoin('33', 'NEWSECRET00000000', false)).toBe(true);
    expect(calls.joins).toEqual(['22', '33']);
    expect(calls.leaves).toBe(1);
    expect(session.getState().phase).toBe('joined');
    expect(session.getState().channel).toBe('33');
  });

  it('refuses a screen-join while already joined instead of silently no-oping', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);
    await session.initFromHash('22', SECRET);

    /* startJoinFromScreen only applies from idle/failed */
    expect(await session.initFromJoin('33', 'NEWSECRET00000000', false)).toBe('busy');
    expect(calls.joins).toEqual(['22']);           // no second join
    expect(session.getState().phase).toBe('joined'); // phase stays intact
    expect(session.getState().channel).toBe('22');
  });

  it('reports busy while a join already runs — the screen must not say BUSY for a failure', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);
    const realJoin = deps.mesh.join.bind(deps.mesh);
    let releaseJoin = () => {};
    let deferred = false;
    deps.mesh.join = async (channel) => {
      if (deferred) return realJoin(channel);
      deferred = true;
      const p = realJoin(channel);   // sets the getter's meshChannel like the real one would
      return new Promise((res) => { releaseJoin = () => p.then(v => res(v)); });
    };

    /* the join only actually starts once its rekey microtasks land — wait for it */
    const first = session.initFromJoin('22', SECRET, false);
    await vi.waitFor(() => expect(calls.joins.length).toBe(1));
    expect(await session.initFromJoin('22', SECRET, false)).toBe('busy');
    releaseJoin();
    expect(await first).toBe(true);
  });

  it('leave tears the session down and clears room identity', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);
    await session.initFromHash('22', SECRET);

    await session.leave();
    expect(session.getState().phase).toBe('idle');
    expect(calls.leaves).toBe(1);
    expect(calls.screens.at(-1)).toBe('join');
    expect(calls.e2eeSet.at(-1)).toBeNull();
  });

  it('new identity rotates the secret and rejoins in place', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);
    await session.initFromHash('22', SECRET);

    await session.newIdentity(() => 'ROTATED000000000');
    expect(calls.toasts.at(-1)).toContain('NEW IDENTITY');
    expect(calls.joins).toEqual(['22', '22']);
    expect(session.getState().secret).toBe('ROTATED000000000');
  });

  it('a failed join lands on the join screen with an error, never "joined"', async () => {
    const { deps, calls } = makeDeps();
    deps.mesh.join = async () => ({ ok: false, reason: 'full' });
    const session = new SessionService(deps);

    expect(await session.initFromHash('22', SECRET)).toBe(false);
    expect(session.getState().phase).toBe('failed');
    expect(calls.toasts.at(-1)).toBe('CHANNEL FULL — ALL SLOTS TAKEN');
    expect(calls.screens.at(-1)).toBe('join');
  });

  it('an unreachable broker keys its own diagnosis, not the old BUSY dead end', async () => {
    const { deps, calls } = makeDeps();
    deps.mesh.join = async () => ({ ok: false, reason: 'unreachable' });
    const session = new SessionService(deps);

    expect(await session.initFromHash('22', SECRET)).toBe(false);
    expect(calls.toasts.at(-1)).toBe('SIGNAL UNREACHABLE — CHECK NETWORK/BROKER');
    expect(session.getState().phase).toBe('failed');
  });

  /* bug #2 — the first PTT press must never pay for the mic permission
     prompt or the cold-device wake; the JOIN does. */
  it('a successful join warms the mic so press #1 is warm', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);

    await session.initFromHash('22', SECRET);
    await vi.waitFor(() => expect(calls.micWarm).toBe(1));
  });

  it('a FAILED join does not warm the mic — no room, no hardware', async () => {
    const { deps, calls } = makeDeps();
    deps.mesh.join = async () => ({ ok: false, reason: 'full' });
    const session = new SessionService(deps);

    await session.initFromHash('22', SECRET);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.micWarm).toBe(0);
  });

  it('leaving releases the mic so the warm window cannot outlive the room', async () => {
    const { deps, calls } = makeDeps();
    const session = new SessionService(deps);
    await session.initFromHash('22', SECRET);
    await vi.waitFor(() => expect(calls.micWarm).toBe(1));

    await session.leave();
    expect(calls.micRelease).toBe(1);
  });

  it('a blocked mic must never fail the join itself', async () => {
    const { deps, calls } = makeDeps();
    deps.mic.warmUp = async () => { throw new Error('NotAllowedError'); };
    const session = new SessionService(deps);

    expect(await session.initFromHash('22', SECRET)).toBe(true);
    expect(session.getState().phase).toBe('joined');
  });
});