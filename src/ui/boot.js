/* ui/boot.js — boot theater, matrix flourish, hint overlay, fitting.
   All battery-aware: reduced-motion users get none of it. */

import { $, toast, log } from './dom.js';

const REDUCED = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function bootSequence(lines) {
  const el = $('bootText');
  if (!el) return;
  if (REDUCED) { el.textContent = lines[lines.length - 1] || ''; return; }
  const full = lines.join(' ▮ ');
  let i = 0;
  const t = setInterval(() => {
    el.textContent = full.slice(0, ++i);
    if (i >= full.length) {
      clearInterval(t);
      /* keep the last line as a permanent status ribbon (PoC cleared it) */
      setTimeout(() => { el.textContent = lines[lines.length - 1] || ''; }, 1200);
    }
  }, 26);
}

/* matrix rain — slow ambient backdrop (~12 fps drift); paused when the
   tab is hidden, skipped for reduced-motion (battery/accessibility). */
export function matrixRain({ fps = 12 } = {}) {
  if (REDUCED || document.hidden) { const c = $('matrix'); c?.remove(); return; }
  const c = $('matrix');
  if (!c) return;
  const x = c.getContext('2d');
  const size = () => { c.width = innerWidth; c.height = innerHeight; };
  size();
  const step = 16, interval = 1000 / fps;
  let cols = Math.floor(c.width / step);
  let drops = Array(cols).fill(0).map(() => Math.random() * -20);
  const glyphs = 'ｱｲｳｴｵｶｷｸｹｺ01▚▞λΣΩ$#@';
  let last = 0, raf = 0, dead = false;
  const onResize = () => {
    size();
    cols = Math.floor(c.width / step);
    drops = Array(cols).fill(0).map(() => Math.random() * -20);
  };
  addEventListener('resize', onResize, { passive: true });
  const onVis = () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!dead && !raf) { last = 0; raf = requestAnimationFrame(rain); }
  };
  document.addEventListener('visibilitychange', onVis);
  function rain(t) {
    raf = 0;
    if (dead || document.hidden) return;
    if (t - last < interval) { raf = requestAnimationFrame(rain); return; }
    last = t;
    x.fillStyle = 'rgba(5,7,5,0.10)';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#174a22'; x.font = '13px monospace';
    drops.forEach((y, i) => {
      const ch = glyphs[(Math.random() * glyphs.length) | 0];
      x.fillText(ch, i * step, y * step);
      drops[i] = y * step > c.height && Math.random() > 0.975 ? Math.random() * -10 : y + 1;
    });
    raf = requestAnimationFrame(rain);
  }
  raf = requestAnimationFrame(rain);
}

export function showHintOnce(seenKey = 'wlk1-seen') {
  const hint = $('hint');
  if (!hint) return;
  const open = () => hint.classList.add('show');
  if (!localStorage.getItem(seenKey)) open();

  $('hintGo')?.addEventListener('click', () => {
    hint.classList.remove('show');
    localStorage.setItem(seenKey, '1');
  });
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
export function fit() {
  const shell = $('shell');
  if (!shell) return;
  const landscape = innerWidth > innerHeight * 1.2 && innerWidth > 700;
  document.body.classList.toggle('wide', landscape);
  const s = Math.min(1, innerHeight / 860, innerWidth / 410);
  shell.style.transform = `scale(${s})`;
}
