/* ui/components/peer-chips.ts — peer chip rendering + speaking indicator. */

import { $ } from '../../infra/dom/dom.js';
import { on, state, linkedCount } from '../../domain/state/state.js';
import type { PeerInfo } from '../../domain/state/state.js';

export function renderChips(peers: Map<number, PeerInfo>): void {
  const box = $('peers');
  if (!box) return;
  const wanted = [...peers.entries()].filter(([, p]) => p.linked).map(([s]) => s).sort((a, b) => a - b);
  const have = [...box.children].map((c) => +(c as HTMLElement).dataset['slot']!);
  if (JSON.stringify(wanted) === JSON.stringify(have)) return;
  box.replaceChildren(...wanted.map((s) => {
    const c = document.createElement('div');
    c.className = 'chip linked'; c.dataset['slot'] = String(s);
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); label.textContent = `UNIT-${s}`;
    c.append(dot, label);
    return c;
  }));
}

export function syncChipsSpeaking(peers: Map<number, PeerInfo>): void {
  const box = $('peers');
  if (!box) return;
  for (const child of box.children) {
    const el = child as HTMLElement;
    const slot = +(el.dataset['slot'] ?? -1);
    el.classList.toggle('speaking', peers.get(slot)?.speaking === true);
  }
}

export function updateGlow(peers?: Map<number, PeerInfo>): void {
  const shell = $('shell');
  if (!(shell instanceof HTMLElement)) return;
  const map = peers ?? state.peers;
  const rx = !state.tx && [...map.values()].some((p) => p.linked && p.speaking);
  shell.classList.toggle('tx-glow', state.tx === true);
  shell.classList.toggle('rx-glow', rx);
  $('antenna')?.classList.toggle('live', state.joined === true || state.tx === true);
}

export function updateLinkedCount(): void {
  const countEl = $('lnkCount');
  if (countEl) countEl.textContent = String(linkedCount());
}

on('peers', (v: unknown) => {
  if (!(v instanceof Map)) return;
  const peers = v as Map<number, PeerInfo>;
  renderChips(peers);
  syncChipsSpeaking(peers);
  updateGlow(peers);
  updateLinkedCount();
});

/* tx/joined feed the shell glow + antenna, not just peer membership */
on('change', () => updateGlow());

export function init(): void {
  updateLinkedCount();
  updateGlow();
}