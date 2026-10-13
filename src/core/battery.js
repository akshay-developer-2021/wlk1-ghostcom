/* core/battery.js — power lifecycle: Battery API, power-save mode,
   visibility, and a small scheduler that pauses everything when the
   tab is hidden or the screen is off. */

import { on, set, state } from './state.js';

export class PowerManager {
  constructor({ documentRef = document, navigatorRef = navigator, log = () => {} } = {}) {
    this.doc = documentRef;
    this.nav = navigatorRef;
    this._log = log;
    this._intervalTimers = new Set();   // timers that must respect hidden state
    this._wakeLock = null;
  }

  init() {
    /* battery + power-save. getBattery doesn't exist on Firefox/Safari —
       plain ?.() chaining would throw on .then and kill this module. */
    try {
      Promise.resolve(this.nav.getBattery?.()).then((b) => {
        if (!b || typeof b.addEventListener !== 'function') return;
        const upd = () => {
          const pct = Math.round(b.level * 100);
          const save = !b.charging && b.level < 0.2;
          set({ powerSave: save });
          this.doc.body.classList.toggle('powsave', save);
          if (save) this._log(`PWR SAVE ENGAGED — ${pct}%`, 'warn');
        };
        b.addEventListener('levelchange', upd);
        b.addEventListener('chargingchange', upd);
        upd();
      }).catch(() => {});
    } catch { /* no Battery API — fine */ }

    /* visibility: hard-pause the render loop and low-value timers */
    this.doc.addEventListener('visibilitychange', () => {
      if (this.doc.hidden) {
        this._log('DISPLAY SLEEP — STANDBY', 'sys');
        set({ screenOn: false });
      } else {
        this._log('DISPLAY WAKE — RESUME', 'sys');
        set({ screenOn: true });
      }
      emitVisibility(this.doc);
    });
    set({ screenOn: !this.doc.hidden });
  }

  /** setInterval replacement: callback skipped while hidden (never cleared). */
  intervalWhenVisible(fn, ms) {
    const t = setInterval(() => { if (!this.doc.hidden) fn(); }, ms);
    this._intervalTimers.add(t);
    return t;
  }

  /** Wake lock held ONLY while transmitting. */
  async holdWake() {
    try {
      this._wakeLock = await this.nav.wakeLock?.request('screen') || null;
    } catch { /* unsupported / denied — fine */ }
    return this._wakeLock;
  }
  async dropWake() {
    try { await this._wakeLock?.release(); } catch { /* noop */ }
    this._wakeLock = null;
  }
}

const visibilityListeners = new Set();
export function onVisibilityChange(fn) { visibilityListeners.add(fn); }
function emitVisibility(doc) { for (const fn of visibilityListeners) fn(!doc.hidden); }

/* ---- VAD-gated render pacing helper ------------------------------
   Callers ask for a frame budget instead of running rAF blindly. */
export function frameBudgetMs(powerSave, active) {
  if (!active) return Infinity;        // loop should sleep entirely
  return powerSave ? 200 : 66;         // 5fps / 15fps
}

/* Shared idle-state helper used by mesh (leg teardown) and ui loop. */
export function isHidden() { return typeof document !== 'undefined' && document.hidden; }

export { on, state };
