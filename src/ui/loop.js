/* ui/loop.js — consolidated render loop with VAD-gated pacing.

   PoC problem: rAF @15fps ran forever while any peer was linked,
   even on a silent channel. Production behavior:
   · live  — speech detected → rAF at 15fps (5fps power-save)
   · idle  — silence > IDLE_MS → drop to a 2Hz poll (still detects
             the next word, ~10× cheaper)
   · sleep — zero analysers → loop fully stopped, AudioContext
             suspended (audio hw idle)
   DOM writes are change-detected; chip refs are cached. */

import { state, on } from '../core/state.js';
import { setLed, setSync } from './dom.js';
import { $ } from './dom.js';

const IDLE_MS = 3000;
const BARS = () => document.querySelectorAll('.vb');

export function createLoop({ sfx, onSuspend }) {
  let txAnalyser = null;
  let txData = null;
  const remotes = new Map();              // slot -> {an, data}
  const chipCache = new Map();            // slot -> element
  let rafOn = false, lastFrame = 0, lastActivity = 0;
  let idleTimer = null;

  on('peers', (peers) => {
    /* cache chip elements; rebuild only when membership changes */
    chipCache.clear();
    for (const [slot] of peers) {
      chipCache.set(slot, document.querySelector(`.chip[data-slot="${slot}"]`));
    }
  });

  function registerTx(analyser) {
    txAnalyser = analyser;
    txData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    BARS().forEach((b) => b.classList.add('live'));
    kick();
  }
  function clearTx() {
    txAnalyser = null; txData = null;
    BARS().forEach((b) => { b.style.height = '4px'; b.classList.remove('live'); });
  }
  function registerRemote(slot, analyser) {
    remotes.set(slot, { an: analyser, data: new Uint8Array(analyser.frequencyBinCount) });
    kick();
  }
  function unregisterRemote(slot) { remotes.delete(slot); }
  function reset() {
    clearTx();
    remotes.clear();
    sleep();
    setLed('rxLed', '');
  }

  function kick() {
    lastActivity = performance.now();
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (!rafOn && !document.hidden) { rafOn = true; requestAnimationFrame(frame); }
  }

  function idle() {
    if (rafOn) { rafOn = false; }
    if (!idleTimer && remotes.size + (txAnalyser ? 1 : 0) > 0 && !document.hidden) {
      idleTimer = setInterval(pollIdle, 500);          // 2Hz standby pulse
    }
  }

  function sleep() {
    rafOn = false;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    BARS().forEach((b) => { b.style.height = '4px'; });
    setLed('rxLed', '');
    onSuspend?.();                                     // AudioContext → suspended
  }

  function pollIdle() {
    if (document.hidden) return;
    if (txAnalyser && hasEnergy(txAnalyser, txData)) { kick(); return; }
    for (const [, o] of remotes) {
      if (hasEnergy(o.an, o.data)) { kick(); sfx.haptic?.(6); return; }
    }
    if (performance.now() - lastActivity > 120_000 && remotes.size === 0) sleep();
  }

  function hasEnergy(an, data) {
    if (!an) return false;
    an.getByteFrequencyData(data);
    let s = 0;
    for (let i = 0; i < data.length; i++) s += data[i];
    return s / data.length > 14;
  }

  function frame(ts) {
    if (document.hidden) { idle(); return; }
    const active = txAnalyser || remotes.size > 0;
    if (!active) { sleep(); return; }
    const step = state.powerSave ? 200 : 66;
    if (ts - lastFrame >= step) {
      lastFrame = ts;
      let anySpeech = false;

      if (txAnalyser) {
        txAnalyser.getByteFrequencyData(txData);
        BARS().forEach((b, i) => {
          const v = txData[Math.min(i * 2 + 1, txData.length - 1)] / 255;
          const h = Math.max(4, 4 + v * 22);
          if (b.__h !== h) { b.style.height = `${h}px`; b.__h = h; }   // write on change
        });
        if (hasEnergy(txAnalyser, txData)) anySpeech = true;
      }

      for (const [slot, o] of remotes) {
        const talk = hasEnergy(o.an, o.data);
        const chip = chipCache.get(slot) || document.querySelector(`.chip[data-slot="${slot}"]`);
        if (chip) chip.classList.toggle('speaking', talk);
        if (talk) anySpeech = true;
      }

      setLed('rxLed', anySpeech ? 'tx' : '');
      if (anySpeech) { lastActivity = ts; setSync('▼ RX ← UNIT SPEAKING', 'on'); }
      else if (state.tx) setSync(`▲ TX → CH ${state.channel} • SQUELCH OPEN`, 'tx');
      if (performance.now() - lastActivity > IDLE_MS) idle();
    }
    if (rafOn) requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { rafOn = false; }
    else if (txAnalyser || remotes.size) kick();
  });

  return { registerTx, clearTx, registerRemote, unregisterRemote, reset, kick };
}
