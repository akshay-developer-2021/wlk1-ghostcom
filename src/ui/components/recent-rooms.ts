/* ui/components/recent-rooms.ts — recent rooms list. */

import { $, safeGet, safeSet, safeRemove } from '../../infra/dom/dom.js';
import { isValidRoomSecret, normalizeRoomSecret } from '../../domain/crypto/crypto.js';

const RECENT_KEY = 'wlk1-recent';
const RECENT_MAX = 8;

interface RecentRoom {
  ch: string;
  secret: string | null;
  ts: number;
}

function readRecents(): RecentRoom[] {
  try {
    const raw = safeGet(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((e): e is RecentRoom =>
      typeof e === 'object' && e !== null &&
      typeof (e as RecentRoom).ch === 'string' && /^\d{2}$/.test((e as RecentRoom).ch) &&
      ((e as RecentRoom).secret === null ||
        isValidRoomSecret(normalizeRoomSecret((e as RecentRoom).secret))));
  } catch {
    return [];
  }
}

export function pushRecent(ch: string, secret: string | null): void {
  const clean = secret !== null && isValidRoomSecret(normalizeRoomSecret(secret))
    ? normalizeRoomSecret(secret) : null;
  const list = readRecents().filter((r) => r.ch !== ch);
  list.unshift({ ch, secret: clean, ts: Date.now() });
  if (list.length > RECENT_MAX) console.log('RECENT DROPPED OLDEST');
  safeSet(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

export function renderRecents(onJoin: (ch: string, secret: string | null) => void): void {
  const box = $('recentList');
  if (!box) return;
  const list = readRecents();
  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = 'NO RECENT ROOMS — JOIN ONE ABOVE';
    box.appendChild(empty);
    return;
  }
  for (const r of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-chip';
    const label = document.createElement('span');
    label.textContent = `CH ${r.ch}`;
    const sub = document.createElement('span');
    sub.className = 'recent-sub';
    sub.textContent = r.secret ? '· KEY SAVED' : '· NEEDS KEY';
    b.append(label, sub);
    b.addEventListener('click', () => onJoin(r.ch, r.secret));
    box.appendChild(b);
  }
}