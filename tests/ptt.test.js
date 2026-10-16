import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { installDom, FakeElement } from './helpers/dom.js';
import { set, state, clearPeers } from '../src/domain/state/state.js';

/* ptt captures document/window at createPTT() time, so the DOM stub is
   installed before the module is imported. */
const pttBtn = new FakeElement('button');
const dom = installDom({ ids: { ptt: pttBtn, toast: new FakeElement('div'), syncBar: new FakeElement('div') } });

const { createPTT } = await import('../src/app/radio/ptt.js');

function makeDeps(overrides = {}) {
  const calls = { beginTx: 0, endTx: 0, release: 0, wake: 0, dropWake: 0 };
  const micStream = { id: 'mic-stream' };
  return {
    calls,
    deps: {
      mesh: {
        peer: { id: 'wlk1-X' },
        channel: '22',
        linked: [],
        join: vi.fn(async () => ({ ok: true })),
        leave: vi.fn(),
        beginTx: vi.fn(async () => { calls.beginTx++; return { attached: 1, redialed: 0 }; }),
        endTx: vi.fn(() => { calls.endTx++; }),
        sendSpeaking: vi.fn(),
        stopQualityPolling: vi.fn(),
        setE2ee: vi.fn(),
      },
      mic: {
        hot: false,
        generation: 1,
        stream: micStream,
        acquire: vi.fn(async () => ({ stream: micStream, track: { id: 't' }, generation: 1 })),
        release: vi.fn(() => { calls.release++; }),
        onEnded: vi.fn(),
      },
      sfx: { haptic: vi.fn(), pttOpen: vi.fn(), pttClose: vi.fn(), roger: vi.fn(), warn: [1] },
      power: { holdWake: vi.fn(() => { calls.wake++; }), dropWake: vi.fn(() => { calls.dropWake++; }) },
      config: { maxTxMs: 300000 },
      ...overrides,
    },
  };
}

let ptt;
beforeEach(() => {
  clearPeers();
  set({ channel: '22', secret: 'ABCDEFGH01234567', joined: true, tx: false, micHot: false });
  const { deps } = makeDeps();
  ptt = createPTT(deps);
});

afterAll(() => dom.restore());   // module-level stub: keep it for every test

describe('PTT', () => {
  it('opens TX on press and closes it on release', async () => {
    await ptt.press('pointer');
    expect(state.tx).toBe(true);
    expect(pttBtn.classList.contains('pressed')).toBe(true);
    ptt.release('pointer');
    expect(state.tx).toBe(false);
    expect(pttBtn.classList.contains('pressed')).toBe(false);
  });

  it('releasing TX stops the mic hardware immediately (no warm window)', async () => {
    const { deps, calls } = makeDeps();
    const ctl = createPTT(deps);
    await ctl.press('pointer');
    ctl.release('pointer');
    expect(calls.release).toBeGreaterThan(0);   // hardware off the moment TX ends
  });

  it('holds TX while any holder remains — releasing one never cuts the other', async () => {
    await ptt.press('pointer');
    await ptt.press('space');
    ptt.release('pointer');          // pointer lets go, space still held
    expect(state.tx).toBe(true);
    ptt.release('space');
    expect(state.tx).toBe(false);
  });

  it('counts one gesture once even when the same holder presses twice', async () => {
    await ptt.press('space');
    await ptt.press('space');
    ptt.release('space');            // single release must be enough
    expect(state.tx).toBe(false);
  });

  it('release-during-arm tears the gesture down without leaving TX open', async () => {
    let resolveAcquire;
    const { deps, calls } = makeDeps();
    deps.mic.acquire = vi.fn(() => new Promise((res) => { resolveAcquire = res; }));
    const ctl = createPTT(deps);

    const pressing = ctl.press('pointer');
    ctl.release('pointer');          // finger left while the mic was waking
    resolveAcquire({ stream: deps.mic.stream, track: { id: 't' }, generation: 1 });
    await pressing;

    expect(state.tx).toBe(false);    // never latched
    expect(calls.endTx).toBeGreaterThan(0);
  });

  it('never opens TX when there is no peer', async () => {
    set({ joined: false });
    const { deps } = makeDeps();
    deps.mesh.peer = null;
    deps.mesh.join = vi.fn(async () => ({ ok: false, reason: 'unreachable' }));
    const ctl = createPTT(deps);
    await ctl.press('pointer');
    expect(state.tx).toBe(false);
    expect(deps.mesh.join).toHaveBeenCalled();
  });

  it('cutoff ends a stuck transmission', async () => {
    vi.useFakeTimers();
    try {
      const { deps } = makeDeps();
      deps.config = { maxTxMs: 50 };
      const ctl = createPTT(deps);
      await ctl.press('pointer');
      expect(state.tx).toBe(true);
      vi.advanceTimersByTime(60);
      expect(state.tx).toBe(false);   // open squelch cannot latch forever
    } finally {
      vi.useRealTimers();
    }
  });
});