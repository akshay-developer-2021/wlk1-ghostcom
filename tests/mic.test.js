import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MicManager } from '../src/domain/audio/mic.js';

function fakeTrack(label = 't') {
  const listeners = {};
  return {
    label, kind: 'audio', enabled: true, stopped: false, readyState: 'live',
    stop() { this.stopped = true; },
    addEventListener(ev, cb) { (listeners[ev] ??= []).push(cb); },
    fire(ev, ...args) { for (const cb of listeners[ev] ?? []) cb(...args); },
  };
}
function fakeGum() {
  const streams = [];
  return {
    streams,
    gum: async () => {
      const t = fakeTrack(`track-${streams.length}`);
      const stream = { getTracks: () => [t], getAudioTracks: () => [t] };
      streams.push(stream);
      return stream;
    },
  };
}

function makeManager(warmMs = 45000) {
  const { gum, streams } = fakeGum();
  const timers = [];
  const mm = new MicManager({
    getUserMedia: gum,
    warmWindowMs: warmMs,
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: (id) => { const i = id - 1; if (timers[i]) timers[i].cleared = true; },
    log: () => {},
  });
  return { mm, streams, timers };
}

describe('MicManager — cold mic policy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acquires hardware on demand and reports hot', async () => {
    const { mm, streams } = makeManager();
    const r = await mm.acquire();
    expect(streams).toHaveLength(1);
    expect(mm.hot).toBe(true);
    expect(mm.warm).toBe(false);
    expect(r.track.kind).toBe('audio');
  });

  it('mute() keeps hardware alive in warm window (track disabled, NOT stopped)', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    mm.mute();
    expect(mm.hot).toBe(false);
    expect(mm.warm).toBe(true);
    expect(streams[0].getTracks()[0].enabled).toBe(false);
    expect(streams[0].getTracks()[0].stopped).toBe(false);   // hardware still on — warm
  });

  it('warm re-acquire reuses the SAME stream with 0 hardware wake', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    mm.mute();
    const r = await mm.acquire();
    expect(streams).toHaveLength(1);                          // no new getUserMedia
    expect(r.stream).toBe(streams[0]);
    expect(streams[0].getTracks()[0].enabled).toBe(true);     // hot again
    expect(mm.hot).toBe(true);
  });

  it('warm window expiry performs the full hardware release', async () => {
    const { mm, streams, timers } = makeManager(45000);
    await mm.acquire();
    mm.mute();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(45000);
    timers[0].fn();                                          // window expires
    expect(streams[0].getTracks()[0].stopped).toBe(true);    // OS mic indicator OFF
    expect(mm.stream).toBeNull();
    expect(mm.hot).toBe(false);
    expect(mm.warm).toBe(false);
  });

  it('release() invalidates in-flight acquires and stops hardware', async () => {
    const { mm, streams } = makeManager();
    const pending = mm.acquire();                             // started, HW resolving
    mm.release();                                             // user released PTT meanwhile
    await expect(pending).rejects.toThrow(/CANCELLED/);
    expect(streams).toHaveLength(1);
    expect(streams[0].getTracks()[0].stopped).toBe(true);     // never leaked
  });

  it('generation token detects the tap race (stale press continuation)', async () => {
    const { mm } = makeManager();
    const r1 = await mm.acquire();
    mm.release();
    const r2 = await mm.acquire();
    expect(r1.generation).not.toBe(r2.generation);
    expect(r1.generation).not.toBe(mm.generation);
    expect(r2.generation).toBe(mm.generation);
  });

  it('zero warm window mutes straight to cold release', async () => {
    const { mm, streams } = makeManager(0);
    await mm.acquire();
    mm.mute();
    expect(streams[0].getTracks()[0].stopped).toBe(true);
    expect(mm.warm).toBe(false);
  });
});

describe('MicManager — dead-track recovery (readyState)', () => {
  it('ended warm track falls through to a cold re-acquire (new hardware stream)', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    mm.mute();
    expect(mm.warm).toBe(true);
    streams[0].getTracks()[0].readyState = 'ended';   // OS revoked / device lost
    const r = await mm.acquire();
    expect(streams).toHaveLength(2);                  // cold getUserMedia again
    expect(streams[0].getTracks()[0].stopped).toBe(true);   // corpse released
    expect(r.stream).toBe(streams[1]);
    expect(mm.hot).toBe(true);
    expect(mm.warm).toBe(false);
  });

  it('warm stream with zero audio tracks is released and reacquired cold', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    mm.mute();
    streams[0].getAudioTracks = () => [];             // device vanished mid-window
    const r = await mm.acquire();
    expect(streams).toHaveLength(2);
    expect(r.stream).toBe(streams[1]);
    expect(mm.hot).toBe(true);
    expect(mm.warm).toBe(false);
  });

  it('track ended event fires onEnded handlers and performs a hard reset', async () => {
    const { mm } = makeManager();
    await mm.acquire();
    const spy = vi.fn();
    mm.onEnded(spy);
    const gen = mm.generation;
    mm.stream.getAudioTracks()[0].fire('ended');      // e.g. OS revoked the mic
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mm.stream).toBeNull();
    expect(mm.hot).toBe(false);
    expect(mm.warm).toBe(false);
    expect(mm.generation).not.toBe(gen);              // stale acquires invalidated
  });
});

/* bug #2 — warmUp() moves the permission prompt + cold-device wake off
   press #1 and onto the join. */
describe('MicManager — join-time warm-up', () => {
  it('warmUp takes the hardware and lands in the warm window (not hot)', async () => {
    const { mm, streams } = makeManager();
    await mm.warmUp();
    expect(streams).toHaveLength(1);
    expect(mm.warm).toBe(true);          // muted, hardware alive
    expect(mm.hot).toBe(false);          // muted: the app must not claim a hot mic
    expect(mm.stream.getAudioTracks()[0].enabled).toBe(false);
  });

  it('the press after warmUp resumes warm with no new getUserMedia', async () => {
    const { mm, streams } = makeManager();
    await mm.warmUp();
    const r = await mm.acquire();
    expect(streams).toHaveLength(1);     // no second hardware grab
    expect(r.track.enabled).toBe(true);
    expect(mm.hot).toBe(true);
  });

  it('warmUp is idempotent — a second call never re-grabs hardware', async () => {
    const { mm, streams } = makeManager();
    await mm.warmUp();
    await mm.warmUp();
    expect(streams).toHaveLength(1);
  });

  it('a denied mic never throws — the join survives and press #1 reports it', async () => {
    const { mm } = makeManager();
    mm._gum = async () => { throw new Error('NotAllowedError'); };
    await expect(mm.warmUp()).resolves.toBeUndefined();
    expect(mm.stream).toBeNull();
    expect(mm.hot).toBe(false);
  });

  it('a press already arming is never cancelled by a join-time warm-up', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { gum, streams } = fakeGum();
    const mm = new MicManager({ getUserMedia: gum, log: () => {} });
    const real = gum;
    mm._gum = async () => { await gate; return real(); };

    /* PTT goes first and is still waiting on hardware */
    const pressing = mm.acquire();
    /* the join lands mid-press and tries to warm up */
    await mm.warmUp();
    release();
    const pressed = await pressing;        // must NOT reject with MIC ACQUIRE CANCELLED

    expect(pressed.track.enabled).toBe(true);
    expect(mm.hot).toBe(true);
    expect(mm.warm).toBe(false);
    expect(streams).toHaveLength(1);       // warm-up stood down entirely
  });
});
