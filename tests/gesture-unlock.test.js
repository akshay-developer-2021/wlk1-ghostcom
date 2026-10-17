import { describe, it, expect, vi, afterEach } from 'vitest';

/* The unlock module's whole job is WHEN it sweeps. The device can take a beat
   to open (Firefox/PulseAudio), so the tap's own pass finds the context
   suspended, bails with AUDIO NOT READY — and the sweep that dials has to
   follow the context, not the tap. */
const silent = vi.hoisted(() => ({ running: false, resolvers: [] }));
vi.mock('../src/domain/audio/silentTrack.js', () => ({
  resumeContext: vi.fn(() => new Promise((resolve) => { silent.resolvers.push(resolve); })),
  silentContextRunning: vi.fn(() => silent.running),
}));
vi.mock('../src/domain/mesh/mesh.js', () => ({ Mesh: class {} }));

const listeners = {};
globalThis.window ??= { addEventListener: (ev, cb) => { listeners[ev] = cb; } };

const { initGestureUnlock } = await import('../src/app/gesture/gesture-unlock.js');

function makeDeps() {
  return {
    sfx: { unlock: vi.fn() },
    mesh: { retryPendingDials: vi.fn(), redialLockedLegs: vi.fn() },
    replayAudio: vi.fn(),
  };
}

describe('gesture unlock — the dial follows the audio context', () => {
  afterEach(() => {
    vi.useRealTimers();
    silent.running = false;
    silent.resolvers.length = 0;
  });

  it('still locked: the gesture pass and its follow-up run, the late pass does not', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    initGestureUnlock(deps);

    listeners['pointerdown']();
    expect(deps.mesh.retryPendingDials).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(deps.mesh.retryPendingDials).toHaveBeenCalledTimes(2);

    silent.resolvers.at(-1)();                  // resume settles — context still suspended
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.mesh.retryPendingDials).toHaveBeenCalledTimes(2);
    expect(silent.resolvers.length).toBe(1);    // the next tap retries
  });

  it('the context opening later is what sweeps, once', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    initGestureUnlock(deps);

    listeners['pointerdown']();
    await vi.advanceTimersByTimeAsync(350);
    expect(deps.mesh.retryPendingDials).toHaveBeenCalledTimes(2);

    silent.running = true;                      // the device finally opens
    silent.resolvers.at(-1)();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.mesh.retryPendingDials).toHaveBeenCalledTimes(3);
    expect(deps.mesh.redialLockedLegs).toHaveBeenCalledTimes(3);

    listeners['pointerdown']();                 // later taps stay cheap
    await vi.advanceTimersByTimeAsync(350);
    expect(deps.mesh.retryPendingDials).toHaveBeenCalledTimes(3);
  });
});
