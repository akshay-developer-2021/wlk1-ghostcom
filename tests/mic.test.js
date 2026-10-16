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

function makeManager() {
  const { gum, streams } = fakeGum();
  const mm = new MicManager({
    getUserMedia: gum,
    log: () => {},
  });
  return { mm, streams };
}

describe('MicManager — PTT-gated capture policy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acquires hardware on demand and reports hot', async () => {
    const { mm, streams } = makeManager();
    const r = await mm.acquire();
    expect(streams).toHaveLength(1);
    expect(mm.hot).toBe(true);
    expect(r.track.kind).toBe('audio');
  });

  it('release() stops the hardware immediately — no warm window', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    mm.release();
    expect(streams[0].getTracks()[0].stopped).toBe(true);   // OS mic indicator OFF
    expect(mm.stream).toBeNull();
    expect(mm.hot).toBe(false);
  });

  it('the press after a release pays a fresh getUserMedia (grant persists, hardware does not)', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    mm.release();
    const r = await mm.acquire();
    expect(streams).toHaveLength(2);                        // no warm reuse
    expect(r.stream).toBe(streams[1]);
    expect(mm.hot).toBe(true);
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
});

describe('MicManager — dead-track recovery (readyState)', () => {
  it('an ended hot track falls through to a cold re-acquire (new hardware stream)', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    streams[0].getTracks()[0].readyState = 'ended';   // OS revoked / device lost
    const r = await mm.acquire();
    expect(streams).toHaveLength(2);                  // cold getUserMedia again
    expect(streams[0].getTracks()[0].stopped).toBe(true);   // corpse released
    expect(r.stream).toBe(streams[1]);
    expect(mm.hot).toBe(true);
  });

  it('a hot stream with zero audio tracks is released and reacquired cold', async () => {
    const { mm, streams } = makeManager();
    await mm.acquire();
    streams[0].getAudioTracks = () => [];             // device vanished mid-hold
    const r = await mm.acquire();
    expect(streams).toHaveLength(2);
    expect(r.stream).toBe(streams[1]);
    expect(mm.hot).toBe(true);
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
    expect(mm.generation).not.toBe(gen);              // stale acquires invalidated
  });
});
