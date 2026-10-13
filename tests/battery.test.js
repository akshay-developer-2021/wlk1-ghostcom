import { describe, it, expect, beforeEach } from 'vitest';
import { PowerManager, onVisibilityChange } from '../src/core/battery.js';
import { state, set } from '../src/core/state.js';

/* No DOM needed — PowerManager takes explicit refs, so every browser
   surface (document, navigator, battery) is a hand-rolled fake. */

function fakeDoc() {
  const listeners = {};
  const toggles = [];
  return {
    hidden: false,
    toggles,
    listeners,
    body: { classList: { toggle: (...args) => toggles.push(args) } },
    addEventListener(ev, cb) { (listeners[ev] ??= []).push(cb); },
    fire(ev) { for (const cb of listeners[ev] ?? []) cb(); },
  };
}

function fakeBattery(level = 0.5, charging = true) {
  const listeners = {};
  return {
    level,
    charging,
    listeners,
    addEventListener(ev, cb) { (listeners[ev] ??= []).push(cb); },
    fire(ev) { for (const cb of listeners[ev] ?? []) cb(); },
  };
}

beforeEach(() => {
  set({ powerSave: false, screenOn: true });
});

describe('PowerManager — degrades gracefully without browser APIs', () => {
  it('init() does not throw without getBattery or wakeLock', () => {
    const pm = new PowerManager({ navigatorRef: {}, documentRef: fakeDoc(), log: () => {} });
    expect(() => pm.init()).not.toThrow();
    expect(state.screenOn).toBe(true);
  });

  it('holdWake/dropWake resolve null-safe without wakeLock', async () => {
    const pm = new PowerManager({ navigatorRef: {}, documentRef: fakeDoc(), log: () => {} });
    await expect(pm.holdWake()).resolves.toBeNull();
    await expect(pm.dropWake()).resolves.toBeUndefined();
  });

  it('engages powerSave below 20% while discharging, clears on charge', async () => {
    const doc = fakeDoc();
    const batt = fakeBattery(0.12, false);
    const pm = new PowerManager({
      navigatorRef: { getBattery: async () => batt },
      documentRef: doc,
      log: () => {},
    });
    pm.init();
    await new Promise((r) => setTimeout(r, 0));   // flush the getBattery microtasks
    expect(state.powerSave).toBe(true);
    expect(doc.toggles).toContainEqual(['powsave', true]);

    batt.charging = true;                         // plugged in — save must clear
    batt.fire('chargingchange');
    expect(state.powerSave).toBe(false);
    expect(doc.toggles).toContainEqual(['powsave', false]);
  });

  it('healthy battery never engages powerSave', async () => {
    const batt = fakeBattery(0.85, false);
    const pm = new PowerManager({
      navigatorRef: { getBattery: async () => batt },
      documentRef: fakeDoc(),
      log: () => {},
    });
    pm.init();
    await new Promise((r) => setTimeout(r, 0));
    expect(state.powerSave).toBe(false);
  });

  it('visibilitychange flips screenOn and notifies listeners', () => {
    const doc = fakeDoc();
    const seen = [];
    onVisibilityChange((v) => seen.push(v));
    const pm = new PowerManager({ navigatorRef: {}, documentRef: doc, log: () => {} });
    pm.init();

    doc.hidden = true;
    doc.fire('visibilitychange');
    expect(state.screenOn).toBe(false);

    doc.hidden = false;
    doc.fire('visibilitychange');
    expect(state.screenOn).toBe(true);
    expect(seen.slice(-2)).toEqual([false, true]);
  });
});
