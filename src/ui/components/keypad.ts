/* ui/components/keypad.ts — keypad controller.

   Owns the digit buffer wiring, the global keyboard map
   (digits, Backspace, Escape, M/S/L shortcuts, volume arrows)
   and the in-band sfx for key presses. */

import { $ } from '../../infra/dom/dom.js';
import { enterDigit, clearDigits, popDigit, getDigits, init as initLcd } from './lcd.js';
import { micTest } from '../../app/audio/mic-test.js';
import { shareChannel } from '../../app/session/share.js';
import { nudge } from './volume-slider.js';
import { copyAllLogs } from '../../infra/dom/dom.js';
import { HAPTIC } from '../../domain/audio/sfx.js';
import type { Sfx } from '../../domain/audio/sfx.js';

export interface KeypadCallbacks {
  onDial: (channel: string) => Promise<void>;
  onSettings: () => void;
  onLeave: () => void;
  sfx?: Sfx;
}

export function init(callbacks: KeypadCallbacks): void {
  const { sfx } = callbacks;
  initLcd();

  const key = (): void => {
    sfx?.key();
    sfx?.haptic(HAPTIC.key);
  };

  document.querySelectorAll('.key[data-digit]').forEach((k) => {
    if (k instanceof HTMLElement) {
      k.addEventListener('click', () => {
        const n = +(k.dataset['digit'] ?? 0);
        key();
        enterDigit(n);
        if (getDigits().length === 2) void callbacks.onDial(getDigits().join(''));
      });
    }
  });

  $('keyDel')?.addEventListener('click', () => { key(); popDigit(); });
  $('keyMic')?.addEventListener('click', () => { key(); void micTest(); });
  $('keyShare')?.addEventListener('click', () => { key(); shareChannel(); });
  $('keySettings')?.addEventListener('click', () => { key(); callbacks.onSettings(); });
  $('keyHelp')?.addEventListener('click', () => { /* help key re-added by boot-screen */ });

  const hint = $('hint');
  const hintOpen = () => hint?.classList.contains('show') ?? false;
  const radioVisible = (): boolean => !($('view-radio')?.classList.contains('hidden') ?? true);

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.repeat) return;
    const target = e.target as HTMLElement;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

    if (hintOpen()) {
      if (e.key === 'Escape') { hint?.classList.remove('show'); return; }
      if (e.key.toLowerCase() === 'h' || e.key === '?') { hint?.classList.toggle('show'); return; }
      return;
    }

    if (/^[0-9]$/.test(e.key) && target?.tagName !== 'INPUT') {
      key();
      enterDigit(+e.key);
      if (getDigits().length === 2) void callbacks.onDial(getDigits().join(''));
      return;
    }
    if (e.key === 'Backspace') { key(); popDigit(); return; }
    if (e.key === 'Escape') { key(); clearDigits(); callbacks.onLeave(); return; }
    if (e.key.toLowerCase() === 'h' || e.key === '?') { hint?.classList.toggle('show'); return; }
    if (!radioVisible()) return;
    if (e.key.toLowerCase() === 'm') { key(); void micTest(); return; }
    if (e.key.toLowerCase() === 's') { key(); shareChannel(); return; }
    if (e.key.toLowerCase() === 'l') { key(); copyAllLogs(); return; }
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { e.preventDefault(); nudge(5); return; }
    if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') { e.preventDefault(); nudge(-5); return; }
  });
}
