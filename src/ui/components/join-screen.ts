/* ui/components/join-screen.ts — join screen controller. */

import { safeGet, safeRemove, safeSessGet, safeSessRemove, safeSessSet, safeSet } from '../../infra/storage/storage.js';
import { $, toast, log, setSync } from '../../infra/dom/dom.js';
import { passphraseStrength } from '../../domain/crypto/crypto.js';
import { generateRoomSecret, deriveSecretFromPassphrase } from '../../domain/crypto/crypto.js';
import { pushRecent, renderRecents } from './recent-rooms.js';

type JoinMode = 'link' | 'pass';

const PASS_STORE_KEY = 'wlk1-pass';

export interface JoinScreenCallbacks {
  onJoin: (channel: string, secret: string, persist: boolean) => Promise<boolean | 'busy'>;
  onOpenSettings: () => void;
}

let joinMode: JoinMode = 'link';
let joining = false;
let callbacksRef: JoinScreenCallbacks | null = null;

export function clearWords(): void {
  safeSessRemove(PASS_STORE_KEY);
  const passEl = $('joinPass');
  if (passEl instanceof HTMLInputElement) passEl.value = '';
  /* the meter paints only on input — reset it with the value */
  const fill = $('passFill');
  if (fill) { fill.style.width = '0%'; fill.dataset.level = '0'; }
  const lab = $('passLabel');
  if (lab) lab.textContent = '—';
}

function setMode(mode: JoinMode): void {
  if (mode !== joinMode) clearWords();
  joinMode = mode;
  $('tabLink')?.classList.toggle('active', mode === 'link');
  $('tabPass')?.classList.toggle('active', mode === 'pass');
  $('tabLink')?.setAttribute('aria-selected', String(mode === 'link'));
  $('tabPass')?.setAttribute('aria-selected', String(mode === 'pass'));
  $('panelLink')?.classList.toggle('hidden', mode !== 'link');
  $('panelPass')?.classList.toggle('hidden', mode !== 'pass');
}

function showError(msg: string): void {
  const el = $('joinErr');
  if (el) el.textContent = msg;
  if (msg) { toast(msg); setSync(msg, 'warn'); }
}

/** A refused join (one already in flight) must say so — silence looks broken. */
async function joinOrExplain(channel: string, secret: string, remember: boolean): Promise<void> {
  const ok = await callbacksRef?.onJoin(channel, secret, remember);
  if (ok === 'busy') showError('BUSY — A JOIN IS ALREADY RUNNING');
  /* false: the join ran and failed — the session toasts the real reason
     (full / unreachable / mismatch), so the inline stays honest */
}

async function doJoin(): Promise<void> {
  if (joining) { showError('JOIN ALREADY RUNNING — HOLD ON'); return; }
  showError('');

  const chRaw = $('joinChannel') instanceof HTMLInputElement
    ? ($('joinChannel') as HTMLInputElement).value : '';
  const channel = chRaw.trim().padStart(2, '0').slice(0, 2);
  if (!/^\d{2}$/.test(channel)) { showError('ENTER A 2-DIGIT CHANNEL (00–99)'); return; }

  const btn = $('joinBtn');
  if (btn instanceof HTMLButtonElement) btn.disabled = true;

  const remember = $('rememberMe') instanceof HTMLInputElement
    && ($('rememberMe') as HTMLInputElement).checked;

  joining = true;
  try {
    if (joinMode === 'link') {
      const secret = generateRoomSecret();
      if (remember) {
        safeSet('wlk1-ch', channel);
        safeSet('wlk1-key', secret);
        pushRecent(channel, secret);
      } else {
        safeRemove('wlk1-ch');
        safeRemove('wlk1-key');
        pushRecent(channel, null);
      }
      log(`CH ${channel} MANUAL JOIN — FRESH KEY${remember ? '' : ' (NOT SAVED)'}`, 'sys');
      await joinOrExplain(channel, secret, remember);
    } else {
      const passEl = $('joinPass');
      const words = passEl instanceof HTMLInputElement ? passEl.value.normalize('NFKC').trim() : '';
      if (words.length < 4) { showError('PASSPHRASE TOO SHORT — 4+ CHARS'); return; }
      if (passphraseStrength(words).score < 2) {
        showError('PASSPHRASE TOO WEAK — 3+ WORDS OR 16+ CHARS');
        return;
      }
      if (btn instanceof HTMLButtonElement) btn.textContent = 'DERIVING…';
      let secret: string;
      try {
        secret = await deriveSecretFromPassphrase(words, channel);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showError(`JOIN FAILED — ${msg}`);
        log(`KDF FAILURE — ${msg}`, 'warn');
        return;
      }
      safeSessSet(PASS_STORE_KEY, words);
      if (remember) {
        safeSet('wlk1-ch', channel);
        safeSet('wlk1-key', secret);
        pushRecent(channel, secret);
      } else {
        safeRemove('wlk1-ch');
        safeRemove('wlk1-key');
        pushRecent(channel, null);
      }
      log(`CH ${channel} PASSPHRASE JOIN — KEY DERIVED${remember ? '' : ' (NOT SAVED)'}`, 'sys');
      await joinOrExplain(channel, secret, remember);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showError(`JOIN FAILED — ${msg}`);
    log(`JOIN FAILED — ${msg}`, 'warn');
  } finally {
    joining = false;
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = false;
      btn.textContent = '▶ JOIN CHANNEL';
    }
  }
}

function setupPassphraseMeter(): void {
  const passInput = $('joinPass');
  if (!(passInput instanceof HTMLInputElement)) return;

  const saved = safeSessGet(PASS_STORE_KEY);
  if (saved) passInput.value = saved;

  const paint = (): void => {
    const { score, label } = passphraseStrength(passInput.value);
    const fill = $('passFill');
    const lab = $('passLabel');
    if (fill) {
      fill.style.width = `${(score / 4) * 100}%`;
      fill.dataset.level = String(score);
    }
    if (lab) lab.textContent = passInput.value ? label : '—';
  };

  passInput.addEventListener('input', paint);
  paint();
}

export function init(cb: JoinScreenCallbacks): void {
  callbacksRef = cb;
  
  $('tabLink')?.addEventListener('click', () => setMode('link'));
  $('tabPass')?.addEventListener('click', () => setMode('pass'));

  setupPassphraseMeter();

  $('joinBtn')?.addEventListener('click', () => doJoin());
  $('joinChannel')?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && e.key === 'Enter') doJoin();
  });
  $('joinPass')?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && e.key === 'Enter') doJoin();
  });
  $('joinSettings')?.addEventListener('click', callbacksRef.onOpenSettings);

  renderRecents((ch, secret) => {
    if (secret) callbacksRef?.onJoin(ch, secret, true);
    else { setMode('pass'); prefillJoin(ch); }
  });
}

export function prefillJoin(channel: string | null): void {
  const input = $('joinChannel');
  if (input instanceof HTMLInputElement && channel && document.activeElement !== input) {
    input.value = channel;
  }
  renderRecents((ch, secret) => {
    if (secret) callbacksRef?.onJoin(ch, secret, true);
    else { setMode('pass'); prefillJoin(ch); }
  });
}

export function isJoining(): boolean { return joining; }