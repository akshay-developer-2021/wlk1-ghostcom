/* ui/components/volume-slider.ts — volume control with persistence. */

import { safeGet, safeSet } from '../../infra/storage/storage.js';
import { $ } from '../../infra/dom/dom.js';

export interface VolumeDeps {
  /** Extra sink for paths el.volume cannot reach (WebAudio graph on iOS). */
  onLevel?: (v: number) => void;
}

let volLevel = 0.8;
let onLevel: ((v: number) => void) | null = null;

export function applyVolume(): void {
  const audioEls = document.querySelectorAll('audio[data-remote]');
  audioEls.forEach((a) => { (a as HTMLAudioElement).volume = volLevel; });
}

export function init(deps?: VolumeDeps): void {
  onLevel = deps?.onLevel ?? null;
  const slider = $('volSlider') as HTMLInputElement | null;
  const val = $('volVal');
  if (!slider) return;

  const stored = Number(safeGet('wlk1-vol') ?? 0.8);
  volLevel = Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 0.8;

  const apply = (): void => {
    volLevel = Math.min(1, Math.max(0, Number(slider.value) / 100));
    slider.style.setProperty('--vol-fill', `${Math.round(volLevel * 100)}%`);
    if (val) val.textContent = String(Math.round(volLevel * 100));
    applyVolume();
    onLevel?.(volLevel);
  };

  slider.value = String(Math.round(volLevel * 100));
  apply();

  slider.addEventListener('input', apply);
  slider.addEventListener('change', () => {
    safeSet('wlk1-vol', String(volLevel));
  });
}

export function nudge(delta: number): void {
  const slider = $('volSlider') as HTMLInputElement | null;
  if (!slider || document.activeElement === slider) return;
  slider.value = String(Math.min(100, Math.max(0, Number(slider.value) + delta)));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

export function getLevel(): number { return volLevel; }