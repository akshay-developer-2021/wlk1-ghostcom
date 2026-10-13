/* ui/ptt.js — the push-to-talk controller.

   Production fixes vs PoC:
   · Generation token per gesture: if the finger leaves before the
     async arm sequence completes, TX never latches (tap-race fix).
   · Keyboard operable (Space / Enter hold) — desktop users exist.
   · TX safety cutoff (config.maxTxMs) — no infinite open squelch.
   · First-press "ARM" state surfaced on the LCD. */

import { set, state } from '../core/state.js';
import { setSync, setLed, setMicLed, log, toast, countPkt } from './dom.js';
import { HAPTIC } from '../audio/sfx.js';

export function createPTT({ mesh, mic, sfx, power, config, onAnalyser }) {
  const btn = document.getElementById('ptt');
  let pressed = false;
  let token = 0;
  let txStart = 0;
  let cutoffTimer = null;

  async function press(e) {
    if (pressed) return;
    pressed = true;
    const gen = ++token;
    e?.preventDefault?.();
    try { e?.pointerId != null && btn.setPointerCapture(e.pointerId); } catch { /* noop */ }
    btn.classList.add('pressed');
    btn.setAttribute('aria-pressed', 'true');
    sfx.haptic(HAPTIC.ptt);
    sfx.pttOpen();

    if (!mesh.peer || !state.joined) {
      setSync('LINKING — JOIN CHANNEL FIRST…', 'warn');
    }
    if (!mesh.peer) await mesh.join(state.channel || '22');
    if (gen !== token) return releasedEarly(gen);           // finger left during join
    if (!state.joined) {
      btn.classList.remove('pressed');
      pressed = false;
      setSync('NO LINK — TRY AGAIN', 'warn');
      sfx.pttClose();
      return;
    }

    setSync('ARMING TX — WAKING MIC…', 'warn');
    try {
      const { stream, track, generation } = await mic.acquire();
      if (generation !== mic.generation || gen !== token) return releasedEarly(gen);
      set({ micHot: true });
      setMicLed(true);
      onAnalyser?.(stream);
      const report = await mesh.beginTx(track);
      if (gen !== token) return releasedEarly(gen);
      if (report.attached === 0 && report.redialed === 0 && mesh.linked.length === 0) {
        log('TX SOLO — NO UNITS LINKED', 'warn');
      }
      beginTxUI();
      cutoffTimer = setTimeout(() => {                      // safety cutoff
        if (pressed) { release(); toast('TX TIMEOUT — 5:00'); log('TX AUTO-CUTOFF', 'warn'); }
      }, config.maxTxMs);
    } catch (err) {
      btn.classList.remove('pressed');
      pressed = false;
      setSync('MIC BLOCKED — CHECK LOCK ICON', 'warn');
      log(`TX FAIL — ${err.message}`, 'warn');
      toast('⚠ ALLOW MIC ACCESS');
      sfx.haptic(HAPTIC.warn);
    }
  }

  function releasedEarly(gen) {
    if (gen === token) { release(); }
  }

  function beginTxUI() {
    txStart = Date.now();
    set({ tx: true });
    setLed('txLed', 'tx');
    setSync(`▲ TX → CH ${state.channel} • SQUELCH OPEN`, 'tx');
    log(`SQUELCH OPEN — CH ${state.channel}`, 'tx');
    countPkt();
    power.holdWake();
  }

  function release() {
    if (!pressed) return;
    pressed = false;
    token++;                              // invalidate any in-flight press path
    clearTimeout(cutoffTimer);
    btn.classList.remove('pressed');
    btn.setAttribute('aria-pressed', 'false');
    if (state.tx) {
      const dur = ((Date.now() - txStart) / 1000).toFixed(1);
      mesh.endTx();
      mic.mute();                         // warm window — instant next TX
      set({ tx: false, micHot: false });
      setMicLed(false);
      setLed('txLed', '');
      log(`SQUELCH CLOSED — ${dur}s`, 'tx');
      countPkt();
      sfx.pttClose();
      sfx.roger();
      power.dropWake();
    } else {
      /* pressed but never armed (join failed / mic blocked) */
      sfx.pttClose();
    }
  }

  /* pointer events */
  btn.addEventListener('pointerdown', press);
  ['pointerup', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, release));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  /* keyboard: hold Space or Enter while the button itself is focused */
  btn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); }
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); }
  });

  /* GLOBAL shortcut: hold SPACE anywhere = push to talk.
     Guards: no auto-repeat, skip while hint dialog is open,
     skip text-entry targets, and release on window blur so a
     held TX can never latch when the window loses focus. */
  const inTextField = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.repeat) return;
    if (inTextField(e.target)) return;
    if (document.getElementById('hint')?.classList.contains('show')) return;
    e.preventDefault();                       // also stops focused-button click + scroll
    press();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault();
    release();
  });
  window.addEventListener('blur', () => release());

  return { press, release, get isPressed() { return pressed; } };
}
