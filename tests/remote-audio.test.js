import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { installDom } from './helpers/dom.js';
import { set, clearPeers, setPeer, removePeer } from '../src/domain/state/state.js';

/* remote-audio owns <audio data-remote> elements and the analyser taps.
   The stub gives it a DOM; sfx/loop are plain fakes. */
const dom = installDom({ ids: {} });

const { initRemoteAudio } = await import('../src/app/radio/remote-audio.js');

function makeDeps() {
  const taps = { registered: [], unregistered: [] };
  const toasts = [];
  const ctx = {
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createAnalyser: vi.fn(() => ({ fftSize: 0, frequencyBinCount: 8, disconnect: vi.fn() })),
  };
  return {
    taps, toasts, ctx,
    deps: {
      sfx: { unlock: vi.fn(), ctx },
      loop: {
        registerRemote: vi.fn((slot) => taps.registered.push(slot)),
        unregisterRemote: vi.fn((slot) => taps.unregistered.push(slot)),
        registerTx: vi.fn(), clearTx: vi.fn(),
      },
      getVolume: () => 0.5,      // getLevel() is a 0..1 fraction
    },
  };
}

function stream(tag) { return { tag }; }

/* initRemoteAudio subscribes to the store for the life of the app (single
   call site), so create it once and reset state between tests. */
const made = makeDeps();
const deps = made.deps, taps = made.taps;
const mod = initRemoteAudio(deps);

beforeEach(() => {
  clearPeers();
  dom.document.body.children.length = 0;
  deps.loop.registerRemote.mockClear();
  deps.loop.unregisterRemote.mockClear();
  taps.registered.length = 0;
  taps.unregistered.length = 0;
});

afterAll(() => dom.restore());

const sinks = () => dom.document.querySelectorAll('audio[data-remote]');

describe('remote audio sink', () => {
  it('creates one element per linked slot and wires the analyser', () => {
    setPeer(3, { linked: true, stream: stream('s3') });
    expect(sinks()).toHaveLength(1);
    expect(sinks()[0].dataset.remote).toBe('3');
    expect(sinks()[0].srcObject.tag).toBe('s3');
    expect(taps.registered).toEqual([3]);
  });

  it('does not rebuild the analyser tap on unrelated peers ticks', () => {
    setPeer(3, { linked: true, stream: stream('s3') });
    setPeer(3, { speaking: true });        // same stream, new tick
    expect(taps.registered).toEqual([3]);  // still one tap
    expect(sinks()[0].srcObject.tag).toBe('s3');
  });

  it('rebuilds the tap when the stream is swapped', () => {
    setPeer(3, { linked: true, stream: stream('first') });
    setPeer(3, { linked: true, stream: stream('second') });
    expect(sinks()[0].srcObject.tag).toBe('second');
    expect(taps.registered).toEqual([3, 3]);
  });

  it('removes the element and tap when a peer unlinks', () => {
    setPeer(3, { linked: true, stream: stream('s3') });
    removePeer(3);
    expect(sinks()).toHaveLength(0);
    expect(taps.unregistered).toEqual([3]);
  });

  it('ignores a peer that is present but not linked (no stream)', () => {
    setPeer(3, { linked: false, stream: null });
    expect(sinks()).toHaveLength(0);
  });

  it('applies the current volume to new sinks', () => {
    setPeer(1, { linked: true, stream: stream('s1') });
    expect(sinks()[0].volume).toBe(0.5);
  });

  it('replays playback for every sink', () => {
    setPeer(1, { linked: true, stream: stream('s1') });
    const el = sinks()[0];
    let played = 0;
    el.playImpl = () => { played++; return Promise.resolve(); };
    mod.replayAudio();
    expect(played).toBe(1);
  });

  it('routes remote audio through the WebAudio gain path while the ctx runs', () => {
    const tapsBefore = taps.registered.length;
    const gain = { gain: { value: 0 }, connect: vi.fn() };
    const runs = { state: 'running', createGain: vi.fn(() => gain) };
    const prevCtx = deps.sfx.ctx;
    deps.sfx.ctx = Object.assign(Object.create(Object.getPrototypeOf(prevCtx)), prevCtx, runs);
    try {
      setPeer(2, { linked: true, stream: stream('s2'), crypto: true });
      expect(taps.registered.length).toBe(tapsBefore + 1);    // analyser unchanged
      expect(runs.createGain).toHaveBeenCalled();
      expect(sinks().at(-1).muted).toBe(true);                // the graph owns loudness
      expect(gain.gain.value).toBe(0.5);                      // slider level seeds the gain
      mod.setVolume(0.3);
      expect(gain.gain.value).toBe(0.3);
    } finally {
      deps.sfx.ctx = prevCtx;
    }
    /* graph gone — the element must go back to the audible fallback path */
    sinks().at(-1).playImpl = () => Promise.resolve();
    mod.replayAudio();
    expect(sinks().at(-1).muted).toBe(false);
    expect(sinks().at(-1).volume).toBe(0.5);
  });
});
/* Regression: two browsers on one machine reported broadband screech with
   no PTT. Cause — the sink played an inbound stream before the decrypt
   transform was attached, so raw AES-GCM hit the Opus decoder. A leg may
   only reach the speakers once its crypto has settled TRUE. */
describe('playback gate — never play un-decrypted frames', () => {
  it('mutes a leg whose crypto handshake has not settled', () => {
    setPeer(4, { linked: true, stream: stream('s4'), crypto: null });
    expect(sinks()).toHaveLength(1);
    expect(sinks()[0].muted).toBe(true);
  });

  it('mutes a leg that negotiated plain SRTP', () => {
    setPeer(5, { linked: true, stream: stream('s5'), crypto: false });
    expect(sinks()[0].muted).toBe(true);
  });

  it('unmutes once crypto settles true, without rebuilding the tap', () => {
    setPeer(6, { linked: true, stream: stream('s6'), crypto: null });
    const before = taps.registered.length;
    expect(sinks()[0].muted).toBe(true);
    setPeer(6, { crypto: true });                 // handshake landed
    expect(sinks()[0].muted).toBe(false);
    expect(taps.registered.length).toBe(before);  // same stream — no re-tap
  });

  it('replayAudio cannot unmute a blocked leg', () => {
    setPeer(7, { linked: true, stream: stream('s7'), crypto: null });
    sinks()[0].playImpl = () => Promise.resolve();
    mod.replayAudio();                            // would force muted=false
    expect(sinks()[0].muted).toBe(true);
  });

  it('a stream with no crypto field at all stays blocked (fail closed)', () => {
    setPeer(8, { linked: true, stream: stream('s8') });
    expect(sinks()[0].muted).toBe(true);
  });
});
