/* ui/boot.ts — boot theater, matrix flourish, hint overlay, fitting.
   All battery-aware: reduced-motion users get none of it. */

import { $, safeGet, safeSet } from './dom.js';

const REDUCED: boolean = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function bootSequence(lines: string[]): void {
  const el = $('bootText');
  if (!el) return;
  if (REDUCED) { el.textContent = lines[lines.length - 1] ?? ''; return; }
  const full = lines.join(' ▮ ');
  let i = 0;
  const t = setInterval(() => {
    el.textContent = full.slice(0, ++i);
    if (i >= full.length) {
      clearInterval(t);
      /* keep the last line as a permanent status ribbon (PoC cleared it) */
      setTimeout(() => { el.textContent = lines[lines.length - 1] ?? ''; }, 1200);
    }
  }, 26);
}

/* matrix rain — slow ambient backdrop (~12 fps drift); paused when the
   tab is hidden, skipped for reduced-motion (battery/accessibility). */
export function matrixRain({ fps = 12 }: { fps?: number } = {}): void {
  if (REDUCED || document.hidden) { $('matrix')?.remove(); return; }
  const found = $('matrix');
  if (!(found instanceof HTMLCanvasElement)) { found?.remove(); return; }
  const c: HTMLCanvasElement = found;
  const x = c.getContext('2d');
  if (!x) return;
  const size = (): void => { c.width = window.innerWidth; c.height = window.innerHeight; };
  size();
  const step = 16, interval = 1000 / fps;
  let cols = Math.floor(c.width / step);
  let drops: number[] = Array(cols).fill(0).map(() => Math.random() * -20);
  const glyphs = 'ｱｲｳｴｵｶｷｸｹｺ01▚▞λΣΩ$#@';
  let last = 0, raf = 0;
  const onResize = (): void => {
    size();
    cols = Math.floor(c.width / step);
    drops = Array(cols).fill(0).map(() => Math.random() * -20);
  };
  window.addEventListener('resize', onResize, { passive: true });
  const onVis = (): void => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = 0; raf = requestAnimationFrame(rain); }
  };
  document.addEventListener('visibilitychange', onVis);
  function rain(t: number): void {
    raf = 0;
    if (document.hidden) return;
    if (t - last < interval) { raf = requestAnimationFrame(rain); return; }
    last = t;
    x!.fillStyle = 'rgba(5,7,5,0.10)';
    x!.fillRect(0, 0, c.width, c.height);
    x!.fillStyle = '#174a22'; x!.font = '13px monospace';
    drops.forEach((y, i) => {
      const ch = glyphs[(Math.random() * glyphs.length) | 0] ?? '?';
      x!.fillText(ch, i * step, y * step);
      drops[i] = y * step > c.height && Math.random() > 0.975 ? Math.random() * -10 : y + 1;
    });
    raf = requestAnimationFrame(rain);
  }
  raf = requestAnimationFrame(rain);
}

export function showHintOnce(seenKey = 'wlk1-seen'): void {
  const hint = $('hint');
  if (!hint) return;
  const open = (): void => { hint.classList.add('show'); };
  if (!safeGet(seenKey)) open();

  $('hintGo')?.addEventListener('click', () => {
    hint.classList.remove('show');
    safeSet(seenKey, '1');
  });
  if (document.getElementById('keyHelp')) return; // idempotent across screens
  /* persistent "?" re-opens help (PoC: one-shot, no recall) */
  const help = document.createElement('button');
  help.className = 'key util help-key';
  help.id = 'keyHelp';
  help.textContent = '?';
  help.setAttribute('aria-label', 'Help');
  help.addEventListener('click', open);
  document.querySelector('.grille')?.appendChild(help);
}

/* fit the fixed 390×844 shell to any viewport */
export function fit(): void {
  const shell = $('shell');
  if (!(shell instanceof HTMLElement)) return;
  const landscape = window.innerWidth > window.innerHeight * 1.2 && window.innerWidth > 700;
  document.body.classList.toggle('wide', landscape);
  const s = Math.min(1, window.innerHeight / 860, window.innerWidth / 410);
  shell.style.transform = `scale(${s})`;
}
