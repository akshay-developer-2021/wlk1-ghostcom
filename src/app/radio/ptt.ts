/* app/radio/ptt.ts — the push-to-talk controller.

   Production fixes vs PoC:
   · Generation token per gesture: if the finger leaves before the
     async arm sequence completes, TX never latches (tap-race fix).
   · abortArming: a release-during-arm tears down anything the stale
     path armed (hot mic, mic-carrying sender) — no ghost mic.
   · Holder refcount: pointer / Space / T-key / api holds share one TX;
     releasing one never cuts another holder's TX.
   · Keyboard operable (Space / Enter hold) — desktop users exist.
   · TX safety cutoff (config.maxTxMs) — no infinite open squelch.
   · First-press "ARM" state surfaced on the LCD. */

import { set, state } from '../../domain/state/state.js';
import { setSync, setLed, setMicLed, log, toast, countPkt, req } from '../../infra/dom/dom.js';
import { HAPTIC } from '../../domain/audio/sfx.js';
import type { Mesh } from '../../domain/mesh/mesh.js';
import type { MicManager } from '../../domain/audio/mic.js';
import type { Sfx } from '../../domain/audio/sfx.js';
import type { PowerManager } from '../../domain/battery.js';
import type { AppConfig } from '../../config.js';

export interface PttDeps {
  mesh: Mesh;
  mic: MicManager;
  sfx: Sfx;
  power: PowerManager;
  config: AppConfig;
  onAnalyser?: (stream: MediaStream) => void;
  /** Fired at the end of the TX teardown branch (after dropWake) so the
      owner can drop TX-scoped resources (e.g. loop.clearTx). Never fired
      from abortArming — nothing armed there. */
  onTxEnd?: () => void;
  /** Gates the GLOBAL Space/T shortcuts only; absent means active. */
  isRadioActive?: () => boolean;
}

/** Concurrent TX owners — one refcount entry per input path. 'pointer'
    is the PTT button, 'space' the global Space shortcut (+ focused-button
    Space), 't' the laptop T-key path, 'enter' the focused-button
    Enter-hold, 'api' the default for programmatic press()/release()
    callers with no holder argument. */
export type PttHolder = 'pointer' | 'space' | 't' | 'api' | 'enter';

export function createPTT({ mesh, mic, sfx, power, config, onAnalyser, onTxEnd, isRadioActive }: PttDeps) {
  const btn = req('ptt');
  let pressed = false;
  const holders = new Set<PttHolder>();
  let token = 0;
  let txStart = 0;
  let cutoffTimer: ReturnType<typeof setTimeout> | null = null;

  /** Map a press/release argument to its holder: an explicit string wins,
      a passed event means the pointer button, omitted means 'api'. */
  const holderOf = (h?: PttHolder | Event): PttHolder =>
    typeof h === 'string' ? h : (h ? 'pointer' : 'api');

  async function press(holderOrEvent?: PttHolder | PointerEvent, e?: PointerEvent): Promise<void> {
    const holder = holderOf(holderOrEvent);
    const ev = typeof holderOrEvent === 'string' ? e : holderOrEvent;
    holders.add(holder);
    if (pressed) return;                       // another holder owns the gesture — refcount only
    pressed = true;
    const gen = ++token;
    ev?.preventDefault?.();
    try { ev?.pointerId != null && btn.setPointerCapture(ev.pointerId); } catch { /* noop */ }
    btn.classList.add('pressed');
    btn.setAttribute('aria-pressed', 'true');
    sfx.haptic(HAPTIC.ptt);
    sfx.pttOpen();

    if (!mesh.peer || !state.joined) {
      setSync('LINKING — JOIN CHANNEL FIRST…', 'warn');
    }
    if (!mesh.peer) {
      /* a join throw (WebCrypto down, broker fatal) must reset the
         button, never escape as an unhandled rejection */
      try {
        await mesh.join(state.channel || '22');
      } catch (err) {
        resetGesture();
        setSync('LINK FAILED — TRY AGAIN', 'warn');
        log(`JOIN FAIL — ${(err as Error)?.message ?? err}`, 'warn');
        toast('LINK FAILED — TRY AGAIN');
        sfx.pttClose();
        return;
      }
    }
    if (gen !== token) return abortArming(gen);           // finger left during join
    if (!state.joined) {
      resetGesture();
      setSync('NO LINK — TRY AGAIN', 'warn');
      sfx.pttClose();
      return;
    }

    setSync('ARMING TX — WAKING MIC…', 'warn');
    try {
      const { stream, track, generation } = await mic.acquire();
      if (generation !== mic.generation || gen !== token) return abortArming(gen);
      if (!track) throw new Error('MIC BLOCKED — NO AUDIO TRACK');
      set({ micHot: true });
      setMicLed(true);
      /* analyser is observability only — its throw must never abort TX */
      try {
        onAnalyser?.(stream);
      } catch (err) {
        log(`ANALYSER HOOK FAIL — ${(err as Error)?.message ?? err}`, 'warn');
      }
      const report = await mesh.beginTx(track);
      if (gen !== token) return abortArming(gen);
      if (report.attached === 0 && report.redialed === 0 && mesh.linked.length === 0) {
        log('TX SOLO — NO UNITS LINKED', 'warn');
      }
      beginTxUI();
      cutoffTimer = setTimeout(() => {                      // safety cutoff
        if (pressed) { forceRelease(); toast('TX TIMEOUT — 5:00'); log('TX AUTO-CUTOFF', 'warn'); }
      }, config.maxTxMs);
    } catch (err) {
      if (gen !== token) return abortArming(gen);   // cancelled mid-arm — teardown, no error UI
      resetGesture();
      setSync('MIC BLOCKED — CHECK LOCK ICON', 'warn');
      log(`TX FAIL — ${(err as Error)?.message ?? err}`, 'warn');
      toast('⚠ ALLOW MIC ACCESS');
      sfx.haptic(HAPTIC.warn);
    }
  }

  /** Release-during-arm: the gesture ended while join / mic-acquire /
      beginTx was still in flight. The stale path may already have warmed
      the mic or attached it to senders, so tear all of it down — never
      leave a hot mic or a mic-carrying sender with no TX state.
      When a newer gesture has since claimed the button (token moved past
      this release) that gesture owns cleanup; do nothing. */
  function abortArming(gen: number): void {
    if (gen + 1 !== token) return;
    try { mesh.endTx(); } catch { /* abort is best-effort — must not throw */ }
    try { mic.mute(); } catch { /* abort is best-effort — must not throw */ }
    set({ micHot: false });
    setMicLed(false);
    btn.classList.remove('pressed');
    btn.setAttribute('aria-pressed', 'false');
    pressed = false;
  }

  /** Full gesture reset with no TX teardown — the arm never completed. */
  function resetGesture(): void {
    holders.clear();
    pressed = false;
    btn.classList.remove('pressed');
    btn.setAttribute('aria-pressed', 'false');
  }

  function beginTxUI(): void {
    txStart = Date.now();
    set({ tx: true });
    setLed('txLed', 'tx');
    setSync(`▲ TX → CH ${state.channel} • SQUELCH OPEN`, 'tx');
    log(`SQUELCH OPEN — CH ${state.channel}`, 'tx');
    countPkt();
    power.holdWake();
    try { mesh.sendSpeaking(true); } catch { /* presence is best-effort */ }
  }

  function teardown(): void {
    pressed = false;
    token++;                              // invalidate any in-flight press path
    if (cutoffTimer != null) { clearTimeout(cutoffTimer); cutoffTimer = null; }
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
      try { mesh.sendSpeaking(false); } catch { /* presence is best-effort */ }
      sfx.pttClose();
      sfx.roger();
      power.dropWake();
      onTxEnd?.();
    } else {
      /* pressed but never armed (join failed / mic blocked) */
      sfx.pttClose();
    }
  }

  function release(holderOrEvent?: PttHolder | Event): void {
    holders.delete(holderOf(holderOrEvent));
    if (holders.size > 0) return;          // another holder still owns TX — keep the air
    if (!pressed) return;
    teardown();
  }

  /** Drop every holder and tear down — blur, safety cutoff, mic death. */
  function forceRelease(): void {
    holders.clear();
    if (!pressed) return;
    teardown();
  }

  /* Sudden mic death mid-TX (device unplugged, OS revoke): never sit in
     TX on a dead track — drop the air and tell the user to re-tap.
     (Warm-expiry stops land here too, but state.tx is already false.) */
  mic.onEnded(() => {
    if (state.tx) {
      toast('MIC LOST — RE-TAP');
      log('MIC LOST MID-TX — DROPPED', 'warn');
      forceRelease();
    }
  });

  /* Locked screen with a warm mic: drop hardware now so the next press
     takes a clean cold path instead of resuming an OS-revoked corpse. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !state.tx && mic.warm) mic.release();
  });

  /* pointer events */
  btn.addEventListener('pointerdown', (ev) => { void press('pointer', ev); });
  for (const ev of ['pointerup', 'pointercancel'] as const) {
    btn.addEventListener(ev, () => release('pointer'));
  }
  /* iOS gesture interrupt (swipe / notification pull-down) can kill
     pointer capture with no pointerup — without this TX latches open. */
  btn.addEventListener('lostpointercapture', () => release('pointer'));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  /* keyboard: hold Space or Enter while the button itself is focused */
  btn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      void press(e.key === 'Enter' ? 'enter' : 'space');
    }
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(e.key === 'Enter' ? 'enter' : 'space'); }
  });

  /* GLOBAL shortcuts: hold SPACE (or T) anywhere = push to talk.
     Guards: no auto-repeat, skip while hint dialog is open,
     skip text-entry targets, native slider keys win while the volume
     slider is focused, and force-release on window blur so a
     held TX can never latch when the window loses focus. */
  const inTextField = (t: EventTarget | null): boolean =>
    !!t && typeof (t as Element).closest === 'function'
    && (t as Element).closest('input, textarea, select, [contenteditable="true"]') != null;
  const shortcutBlocked = (t: EventTarget | null): boolean =>
    isRadioActive?.() === false
    || inTextField(t)
    || document.activeElement?.id === 'volSlider'   // native slider keys win
    || (document.getElementById('hint')?.classList.contains('show') ?? false);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.key === ' ') {
      if (shortcutBlocked(e.target)) return;
      e.preventDefault();                       // also stops focused-button click + scroll
      void press('space');
      return;
    }
    if (e.key.toLowerCase() === 't') {
      if (shortcutBlocked(e.target)) return;
      void press('t');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (isRadioActive?.() === false) return;
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); release('space'); return; }
    if (e.key.toLowerCase() === 't') { e.preventDefault(); release('t'); }
  });
  window.addEventListener('blur', () => forceRelease());

  return { press, release, get isPressed() { return pressed; } };
}
