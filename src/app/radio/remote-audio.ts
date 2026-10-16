/* app/radio/remote-audio.ts — remote stream sink.

   Owns the <audio data-remote> elements and the analyser taps that feed
   the render loop (VU bars + speaking chips). Remote loudness goes through
   the WebAudio graph (iOS Safari ignores el.volume); this module asks for
   the current level once per new element and on every peers change. */

import { on } from '../../domain/state/state.js';
import type { PeerInfo } from '../../domain/state/state.js';
import { toast } from '../../infra/dom/dom.js';
import type { Sfx } from '../../domain/audio/sfx.js';
import type { RenderLoop } from './voice-loop.js';

export interface RemoteAudioDeps {
  sfx: Sfx;
  loop: RenderLoop;
  getVolume: () => number;
}

export interface RemoteAudio {
  /** Build the shared analyser graph for a stream (TX or RX). */
  analyserFor: (stream: MediaStream) => { an: AnalyserNode; src: AudioNode } | null;
  /** Re-attempt playback for all sinks (called from the first gesture). */
  replayAudio: () => void;
  /** Push a slider level into the WebAudio gain path. */
  setVolume: (v: number) => void;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function initRemoteAudio({ sfx, loop, getVolume }: RemoteAudioDeps): RemoteAudio {
  function analyserFor(stream: MediaStream): { an: AnalyserNode; src: AudioNode } | null {
    try {
      sfx.unlock();
      if (!sfx.ctx) return null;
      const src = sfx.ctx.createMediaStreamSource(stream);
      const an = sfx.ctx.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      return { an, src };
    } catch {
      return null;
    }
  }

  const sinks = new Map<number, HTMLAudioElement>();
  const sinkTaps = new Map<number, { an: AnalyserNode; src: AudioNode }>();
  /** Slots whose frames must never reach the speakers: crypto is still
      null (handshake un-settled → raw AES-GCM) or false (plain SRTP). */
  const cryptoBlocked = new Set<number>();
  let sharedGain: GainNode | null = null;
  let unmuteHinted = false;

  /** One shared gain node for every remote stream — src → gain → speakers. */
  function remoteGain(): GainNode | null {
    if (!sfx.ctx) return null;
    if (!sharedGain) {
      try {
        sharedGain = sfx.ctx.createGain();
        sharedGain.gain.value = clamp01(getVolume());
        sharedGain.connect(sfx.ctx.destination);
      } catch { sharedGain = null; }
    }
    return sharedGain;
  }

  /** Route a sink through the graph when the ctx runs (iOS Safari ignores
      el.volume); otherwise the element stays the audible path. */
  function routeSink(slot: number, el: HTMLAudioElement): void {
    const tap = sinkTaps.get(slot);
    let routed = false;
    if (tap && sfx.ctx && sfx.ctx.state === 'running') {
      const g = remoteGain();
      if (g) {
        try { tap.src.connect(g); el.muted = true; routed = true; } catch { /* noop */ }
      }
    }
    if (!routed) {
      /* NEVER play a leg whose decrypt transform is not attached: the
         inbound frames are raw AES-GCM (crypto null) or cleartext (false)
         and the Opus decoder turns them into broadband screech. This gate
         is authoritative — routeSink and replayAudio both write `muted`,
         so every writer must go through here. */
      el.muted = cryptoBlocked.has(slot);
      if (!el.muted) el.volume = clamp01(getVolume());
    }
  }

  function replayAudio(): void {
    for (const [slot, el] of sinks) {
      el.play().catch(() => { /* gesture required — retried */ });
      routeSink(slot, el);   // the first gesture may have unlocked the graph since
    }
  }

  on('peers', (v: unknown) => {
    if (!(v instanceof Map)) return;
    const peers = v as Map<number, PeerInfo>;
    for (const [slot, p] of peers) {
      const stream = p.linked ? (p.stream ?? null) : null;
      if (!stream) continue;                       // sweep below removes dead sinks
      let el = sinks.get(slot);
      if (!el) {
        el = document.createElement('audio');
        el.dataset['remote'] = String(slot);
        el.autoplay = true;
        el.volume = Math.min(1, Math.max(0, getVolume()));
        document.body.appendChild(el);
        sinks.set(slot, el);
      }
      /* 'peers' also fires for speaking/quality ticks — rebuild the tap
         only when the stream itself was swapped */
      if (el.srcObject !== stream) {
        el.srcObject = stream;
        /* Keep the playback gate authoritative across every path that
           writes `muted` (this block, routeSink, replayAudio). */
        if (p.crypto === true) cryptoBlocked.delete(slot); else cryptoBlocked.add(slot);
        el.play().catch(() => {
          /* say it once — a locked context would otherwise re-toast on every
             reconnect and bury the screen in identical warnings */
          if (unmuteHinted) return;
          unmuteHinted = true;
          toast('TAP TO UNMUTE');
        });
        const tap = analyserFor(stream);
        if (tap) {
          sinkTaps.set(slot, tap);
          loop.registerRemote(slot, tap.an, tap.src);
        }
        routeSink(slot, el);
      } else if (p.crypto === true ? cryptoBlocked.delete(slot) : cryptoBlocked.add(slot)) {
        /* crypto settled after the stream landed — (un)mute accordingly */
        routeSink(slot, el);
      }
    }
    for (const [slot, el] of sinks) {              // slots gone or unlinked
      if (!peers.get(slot)?.linked) {
        el.remove();
        sinks.delete(slot);
        cryptoBlocked.delete(slot);
        sinkTaps.delete(slot);
        loop.unregisterRemote(slot);
      }
    }
  });

  return {
    analyserFor,
    replayAudio,
    setVolume: (v: number): void => {
      if (sharedGain) sharedGain.gain.value = clamp01(v);
    },
  };
}
