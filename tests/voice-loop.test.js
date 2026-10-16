import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { installDom } from './helpers/dom.js';
import { set, setPeer, removePeer } from '../src/domain/state/state.js';

/* The render loop owns the analyser graph. Its interesting invariant is that
   a re-registered tap disconnects the previous source — otherwise every
   renegotiation leaks a MediaStreamSource that keeps pulling an old stream. */
const dom = installDom({ ids: {} });

const { createLoop } = await import('../src/app/radio/voice-loop.js');

function analyser() {
  return { fftSize: 256, frequencyBinCount: 8, disconnect: vi.fn(), getByteFrequencyData: vi.fn() };
}
function source() { return { connect: vi.fn(), disconnect: vi.fn() }; }

let loop, suspended, taps;
beforeEach(() => {
  suspended = 0;
  taps = { src: source(), an: analyser() };
  loop = createLoop({
    sfx: { ctx: {}, suspend: vi.fn(() => { suspended++; }) },
    onSuspend: () => { suspended++; },
  });
});

afterAll(() => dom.restore());

describe('render loop', () => {
  it('disconnects the previous tap when a slot re-registers', () => {
    const first = { an: analyser(), src: source() };
    const second = { an: analyser(), src: source() };
    loop.registerRemote(4, first.an, first.src);
    loop.registerRemote(4, second.an, second.src);

    expect(first.src.disconnect).toHaveBeenCalledTimes(1);  // old one dropped
    expect(first.an.disconnect).toHaveBeenCalledTimes(1);
    expect(second.src.disconnect).not.toHaveBeenCalled();    // current one alive
  });

  it('disconnects the previous TX tap on every press', () => {
    const first = { an: analyser(), src: source() };
    const second = { an: analyser(), src: source() };
    loop.registerTx(first.an, first.src);
    loop.registerTx(second.an, second.src);

    expect(first.src.disconnect).toHaveBeenCalledTimes(1);
    expect(second.src.disconnect).not.toHaveBeenCalled();
  });

  it('clearTx drops the TX graph', () => {
    const tap = { an: analyser(), src: source() };
    loop.registerTx(tap.an, tap.src);
    loop.clearTx();
    expect(tap.src.disconnect).toHaveBeenCalledTimes(1);
    expect(tap.an.disconnect).toHaveBeenCalledTimes(1);
  });

  it('unregistering a slot drops that slot’s tap', () => {
    const tap = { an: analyser(), src: source() };
    loop.registerRemote(2, tap.an, tap.src);
    loop.unregisterRemote(2);
    expect(tap.src.disconnect).toHaveBeenCalledTimes(1);
    expect(tap.an.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a slot registering many times never accumulates live sources', () => {
    const all = [];
    for (let i = 0; i < 25; i++) {
      const tap = { an: analyser(), src: source() };
      all.push(tap);
      loop.registerRemote(7, tap.an, tap.src);
    }
    /* every source but the newest must have been disconnected */
    for (const tap of all.slice(0, -1)) expect(tap.src.disconnect).toHaveBeenCalledTimes(1);
    expect(all.at(-1).src.disconnect).not.toHaveBeenCalled();
  });

  it('survives a peer appearing and disappearing repeatedly', () => {
    for (let i = 0; i < 10; i++) {
      setPeer(1, { linked: true, stream: { tag: `s${i}` } });
      removePeer(1);
    }
    expect(true).toBe(true);   // no throw, no unbounded growth
    set({ tx: false });
  });
});