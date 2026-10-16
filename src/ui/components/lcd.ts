/* ui/components/lcd.ts — LCD display controller.

   Owns the display band: channel digits, sync bar text, LED mirror,
   E2EE/SAS badge, and the quality sigbars. Subscribes to the domain
   state bus (the same bus the mesh writes to). */

import { $, log, setSync } from '../../infra/dom/dom.js';
import { state, on, linkedCount } from '../../domain/state/state.js';
import { onCrypto, onQuality } from '../../domain/mesh/mesh.js';

let digitBuf: string[] = [];

export function updateDisplay(): void {
  const entering = digitBuf.length === 1;
  const ch = digitBuf.length ? digitBuf.join('') : (state.channel || '--');
  const chanEl = $('chan');
  if (chanEl) chanEl.textContent = `CH ${ch}${entering ? '_' : ''}`;
  const freqEl = $('freq');
  if (freqEl) freqEl.textContent = `152.${String(ch).padStart(3, '0')}`;
  $('lcd')?.classList.toggle('entering', entering);
}

export function enterDigit(n: number): void {
  if (digitBuf.length >= 2) digitBuf = digitBuf.slice(1);
  digitBuf.push(String(n));
  updateDisplay();
}

export function clearDigits(): void {
  digitBuf = [];
  updateDisplay();
}

export function popDigit(): void {
  digitBuf.pop();
  updateDisplay();
}

export function getDigits(): string[] {
  return [...digitBuf];
}

on('channel', () => {
  if (digitBuf.length === 0) updateDisplay();
});

/* ── E2EE / SAS badge ───────────────────────────────────── */
/* Three producers (mode, crypto status, SAS) share one element — each
   writer re-renders the whole badge so none can erase the others. */
function setEnc(text: string): void {
  const el = document.querySelector('.enc');
  if (el && el.textContent !== text) el.textContent = text;
}

let cryptoStatus: string | null = null;

function renderBadge(): void {
  let text: string;
  if (cryptoStatus === 'srtp-only' || state.e2eeMode === 'dtls-only') text = '🔒 SRTP';
  else if (cryptoStatus === 'mixed') text = '🔒 MIXED · SOME SRTP';
  else if (cryptoStatus === 'e2ee') text = '🔒 E2E';
  else text = state.e2eeMode === 'e2ee-ready' ? '🔒 E2E READY' : '🔒 SRTP';
  /* the SAS lives in the store — the mesh owns it and clears it on leave */
  if (state.sas && text.includes('E2E')) text = `${text} · ${state.sas}`;
  setEnc(text);
}

on('e2eeMode', () => renderBadge());

on('sas', (v: unknown) => {
  if (typeof v !== 'string' || !v) return;
  renderBadge();
  log(`SAS ${v} — VERIFY BY VOICE`, 'sys');
});

onCrypto((status: string) => {
  cryptoStatus = status;
  renderBadge();
});

/* ── quality sigbars ────────────────────────────────────── */
onQuality((q: number) => {
  document.querySelectorAll('.sigbars i').forEach((el, i) => el.classList.toggle('on', i < q));
});

/* ── link lifecycle text ────────────────────────────────── */
/* Derived from all three: a broker reconnect must not downgrade the banner
   while the leg is live, and a lone unit on the channel is not a link. */
function syncLinkText(): void {
  if (state.joined && linkedCount() > 0) setSync('LINK ESTABLISHED — LISTENING', 'on');
  else if (state.joined) setSync('ON CHANNEL — NO OTHER UNITS', 'warn');
  else if (state.connected) setSync('BROKER CONNECTED — LINKING…', 'on');
  else setSync('BROKER LOST — RETRYING…', 'warn');
}

on('connected', () => { syncLinkText(); if (state.joined) updateDisplay(); });

on('joined', () => { syncLinkText(); updateDisplay(); });

/* the banner depends on how many units are linked, so a peer arriving or
   leaving has to re-render it */
on('peers', () => syncLinkText());

export function init(): void {
  updateDisplay();
}
