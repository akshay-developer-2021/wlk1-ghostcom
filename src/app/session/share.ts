/* app/session/share.ts — share channel link. */

import { toast, log } from '../../infra/dom/dom.js';
import { state, set } from '../../domain/state/state.js';
import { normalizeRoomSecret, isValidRoomSecret, buildShareLink } from '../../domain/crypto/crypto.js';
import { safeSet } from '../../infra/storage/storage.js';

export function shareChannel(): void {
  const raw = typeof state.secret === 'string' ? state.secret : '';
  const norm = normalizeRoomSecret(raw);
  if (!isValidRoomSecret(norm)) {
    toast('BAD KEY — CHECK LINK');
    log('BAD KEY — SHARE REFUSED — CHECK LINK', 'warn');
    return;
  }
  if (norm !== raw) set({ secret: norm });

  const url = buildShareLink(state.channel || '22', norm, location.origin, location.pathname);
  const done = (): void => {
    toast(`LINK COPIED — CH ${state.channel}`);
    log(`URL EXPORTED — CH ${state.channel} (+KEY)`, 'sys');
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
}

function fallbackCopy(url: string, done: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = url; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('COPY FAILED'); }
  ta.remove();
}