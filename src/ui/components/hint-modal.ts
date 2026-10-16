/* ui/components/hint-modal.ts — hint/help modal. */

import { $ } from '../../infra/dom/dom.js';

export function init(): void {
  const hint = $('hint');
  if (!hint) return;

  hint.addEventListener('click', (e) => {
    if (e.target === hint) toggle(false);
  });
  $('hintGo')?.addEventListener('click', () => toggle(false));
}

export function toggle(show?: boolean): void {
  const hint = $('hint');
  if (!hint) return;
  const next = show ?? !hint.classList.contains('show');
  hint.classList.toggle('show', next);
}

export function isOpen(): boolean {
  return $('hint')?.classList.contains('show') ?? false;
}