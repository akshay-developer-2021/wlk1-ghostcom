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

/* matrix rain — continuous boot flourish; skipped for
   reduced-motion and hidden tabs (wasted GPU otherwise) */
export function matrixRain() {
  if (REDUCED || document.hidden) { const c = $('matrix'); c?.remove(); return; }
  const c = $('matrix');
  if (!c) return;
  const x = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const cols = Math.floor(c.width / 14);
  const drops = Array(cols).fill(0);
  const glyphs = 'ｱｲｳｴｵｶｷｸｹｺ01▚▞λΣΩ$#@';
  (function rain() {
    x.fillStyle = 'rgba(5,7,5,0.12)'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#1e5a2a'; x.font = '12px monospace';
    drops.forEach((y, i) => {
      x.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * 14, y * 14);
      drops[i] = y * 14 > c.height && Math.random() > 0.97 ? 0 : y + 1;
    });
    requestAnimationFrame(rain);
  })();
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
