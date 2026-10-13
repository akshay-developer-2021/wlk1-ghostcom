/* ui/loop.ts — consolidated render loop with VAD-gated pacing.

   PoC problem: rAF @15fps ran forever while any peer was linked,
   even on a silent channel. Production behavior:
   · live  — speech detected → rAF at 15fps (5fps power-save)
   · idle  — silence > IDLE_MS → drop to a 2Hz poll (still detects
             the next word, ~10× cheaper)
   · sleep — zero analysers → loop fully stopped, AudioContext
             suspended (audio hw idle)
   DOM writes are change-detected; chip refs are cached. */

import { state, on } from '../core/state.js';
import type { PeerInfo } from '../core/state.js';
import { setLed, setSync } from './dom.js';

/** Minimal structural surface the loop needs from the sfx module. */
export interface LoopSfx {
  haptic?: (n: number | number[]) => void;
}

export interface LoopOptions {
  sfx: LoopSfx;
  onSuspend?: () => void;
}

export interface RenderLoop {
  registerTx: (analyser: AnalyserNode | null, src?: AudioNode | null) => void;
  clearTx: () => void;
  registerRemote: (slot: number, analyser: AnalyserNode, src?: AudioNode | null) => void;
  unregisterRemote: (slot: number) => void;
  kick: () => void;
}

interface RemoteTap {
  an: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  src: AudioNode | null;
}

const IDLE_MS = 3000;
const BARS = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('.vb');

export function createLoop({ sfx, onSuspend }: LoopOptions): RenderLoop {
  let txAnalyser: AnalyserNode | null = null;
  let txData: Uint8Array<ArrayBuffer> | null = null;
  let txSrc: AudioNode | null = null;
  const remotes = new Map<number, RemoteTap>();   // slot -> {an, data}
  const chipCache = new Map<number, Element | null>(); // slot -> element
  const declaredSpeaking = new Map<number, boolean>(); // slot -> peer-reported PTT
  let rafOn = false, lastFrame = 0, lastActivity = 0;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  on('peers', (v: unknown) => {
    if (!(v instanceof Map)) return;
    const peers = v as Map<number, PeerInfo>;
    /* cache chip elements; rebuild only when membership changes */
    chipCache.clear();
    declaredSpeaking.clear();
    for (const [slot, p] of peers) {
      chipCache.set(slot, document.querySelector(`.chip[data-slot="${slot}"]`));
      declaredSpeaking.set(slot, p.speaking === true);
    }
  });

  /** Disconnect a tap's graph edges so a replaced tap stops pulling
      its old stream. Never throws — safe on any teardown path. */
  function dropTap(tap: RemoteTap | undefined): void {
    if (!tap) return;
    try { tap.src?.disconnect(); } catch { /* noop */ }
    try { tap.an.disconnect(); } catch { /* noop */ }
  }

  function registerTx(analyser: AnalyserNode | null, src?: AudioNode | null): void {
    /* every TX press builds a fresh source — drop the previous one or it
       keeps pulling the old stream (one leaked source per press) */
    if (txSrc) { try { txSrc.disconnect(); } catch { /* noop */ } txSrc = null; }
    try { txAnalyser?.disconnect(); } catch { /* noop */ }
    txAnalyser = analyser;
    txData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    txSrc = src ?? null;
    BARS().forEach((b) => b.classList.add('live'));
    kick();
  }
  function clearTx(): void {
    if (txSrc) { try { txSrc.disconnect(); } catch { /* noop */ } txSrc = null; }
    try { txAnalyser?.disconnect(); } catch { /* noop */ }
    txAnalyser = null; txData = null;
    BARS().forEach((b) => { b.style.height = '4px'; b.classList.remove('live'); });
  }
  function registerRemote(slot: number, analyser: AnalyserNode, src?: AudioNode | null): void {
    /* stream-swap re-register: disconnect the previous slot source before
       replacing it, or the orphaned MediaStreamSource keeps pulling the
       old stream — a graph leak per renegotiation */
    dropTap(remotes.get(slot));
    remotes.set(slot, { an: analyser, data: new Uint8Array(analyser.frequencyBinCount), src: src ?? null });
    kick();
  }
  function unregisterRemote(slot: number): void { dropTap(remotes.get(slot)); remotes.delete(slot); }

  function kick(): void {
    lastActivity = performance.now();
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (!rafOn && !document.hidden) { rafOn = true; requestAnimationFrame(frame); }
  }

  function idle(): void {
    if (rafOn) { rafOn = false; }
    if (!idleTimer && remotes.size + (txAnalyser ? 1 : 0) > 0 && !document.hidden) {
      idleTimer = setInterval(pollIdle, 500);          // 2Hz standby pulse
    }
  }

  function sleep(): void {
    rafOn = false;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    BARS().forEach((b) => { b.style.height = '4px'; });
    setLed('rxLed', '');
    onSuspend?.();                                     // AudioContext → suspended
  }

  function pollIdle(): void {
    if (document.hidden) return;
    if (txAnalyser && txData && hasEnergy(txAnalyser, txData)) { kick(); return; }
    for (const [, o] of remotes) {
      if (hasEnergy(o.an, o.data)) { kick(); try { sfx.haptic?.(6); } catch { /* noop */ } return; }
    }
    if (performance.now() - lastActivity > 120_000 && remotes.size === 0) sleep();
  }

  function hasEnergy(an: AnalyserNode | null, data: Uint8Array<ArrayBuffer> | null): boolean {
    if (!an || !data) return false;
    an.getByteFrequencyData(data);
    let s = 0;
    for (let i = 0; i < data.length; i++) s += data[i] ?? 0;
    return s / data.length > 14;
  }

  function frame(ts: number): void {
    if (document.hidden) { idle(); return; }
    const active = txAnalyser || remotes.size > 0;
    if (!active) { sleep(); return; }
    const step = state.powerSave ? 200 : 66;
    if (ts - lastFrame >= step) {
      lastFrame = ts;
      let anySpeech = false;

      if (txAnalyser && txData) {
        txAnalyser.getByteFrequencyData(txData);
        const bins = txData;
        BARS().forEach((b, i) => {
          const v = (bins[Math.min(i * 2 + 1, bins.length - 1)] ?? 0) / 255;
          const h = Math.max(4, 4 + v * 22);
          if ((b as HTMLElement & { __h?: number }).__h !== h) {
            b.style.height = `${h}px`;
            (b as HTMLElement & { __h?: number }).__h = h;
          }   // write on change
        });
        if (hasEnergy(txAnalyser, txData)) anySpeech = true;
      }

      for (const [slot, o] of remotes) {
        const talk = hasEnergy(o.an, o.data) || declaredSpeaking.get(slot) === true;
        const chip = chipCache.get(slot) ?? document.querySelector(`.chip[data-slot="${slot}"]`);
        if (chip) chip.classList.toggle('speaking', talk);
        if (talk) anySpeech = true;
      }

      setLed('rxLed', anySpeech ? 'tx' : '');
      if (anySpeech) { lastActivity = ts; setSync('▼ RX ← UNIT SPEAKING', 'on'); }
      else if (state.tx && typeof state.channel === 'string') {
        setSync(`▲ TX → CH ${state.channel} • SQUELCH OPEN`, 'tx');
      }
      if (performance.now() - lastActivity > IDLE_MS) idle();
    }
    if (rafOn) requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { rafOn = false; }
    else if (txAnalyser || remotes.size) kick();
  });

  return { registerTx, clearTx, registerRemote, unregisterRemote, kick };
}
