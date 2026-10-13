/* core/battery.ts — power lifecycle: Battery API, power-save mode,
   visibility, and a small scheduler that pauses everything when the
   tab is hidden or the screen is off. */

import { on, set, state } from './state.js';

type LogFn = (msg: string, kind?: string) => void;

/** Minimal BatteryManager surface (lib.dom lacks getBattery typing). */
export interface BatteryLike {
  level: number;
  charging: boolean;
  addEventListener(type: string, cb: () => void): void;
}

export interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export type NavigatorLike = Navigator & {
  getBattery?: () => Promise<BatteryLike | undefined | null>;
};

export interface PowerManagerOptions {
  documentRef?: Document;
  navigatorRef?: NavigatorLike;
  log?: LogFn;
}

export class PowerManager {
  private doc: Document;
  private nav: NavigatorLike;
  private _log: LogFn;
  private _wakeLock: WakeLockSentinelLike | null;
  private _battCb = new Set<(level: number, charging: boolean) => void>();

  constructor({ documentRef = document, navigatorRef = navigator, log = () => {} }: PowerManagerOptions = {}) {
    this.doc = documentRef;
    this.nav = navigatorRef;
    this._log = log;
    this._wakeLock = null;
  }

  onBattery(cb: (level: number, charging: boolean) => void): void { this._battCb.add(cb); }

  init(): void {
    /* battery + power-save. getBattery doesn't exist on Firefox/Safari —
       plain ?.() chaining would throw on .then and kill this module. */
    try {
      Promise.resolve(this.nav.getBattery?.()).then((b) => {
        if (!b || typeof b.addEventListener !== 'function') return;
        const upd = (): void => {
          const pct = Math.round(b.level * 100);
          const save = !b.charging && b.level < 0.2;
          set({ powerSave: save });
          this.doc.body.classList.toggle('powsave', save);
          for (const fn of this._battCb) fn(b.level, b.charging);
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

  /** Wake lock held ONLY while transmitting. */
  async holdWake(): Promise<WakeLockSentinelLike | null> {
    try {
      this._wakeLock = await this.nav.wakeLock?.request('screen') ?? null;
    } catch { /* unsupported / denied — fine */ }
    return this._wakeLock;
  }
  async dropWake(): Promise<void> {
    try { await this._wakeLock?.release(); } catch { /* noop */ }
    this._wakeLock = null;
  }
}

type VisibilityListener = (visible: boolean) => void;
const visibilityListeners = new Set<VisibilityListener>();
export function onVisibilityChange(fn: VisibilityListener): void { visibilityListeners.add(fn); }
function emitVisibility(doc: Document): void { for (const fn of visibilityListeners) fn(!doc.hidden); }

export { on, state };
