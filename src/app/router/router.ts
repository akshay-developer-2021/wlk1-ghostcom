/* app/router/router.ts — hash router. */

import { isValidRoomSecret, normalizeRoomSecret } from '../../domain/crypto/crypto.js';

export type Route = 
  | { type: 'join'; channel?: string }
  | { type: 'radio'; channel: string; secret: string }
  | { type: 'settings' };

export function parseHash(hash: string): Route {
  const clean = hash.endsWith('.') ? hash.slice(0, -1) : hash;
  
  if (/^#settings($|[?/])/.test(clean)) return { type: 'settings' };
  
  const mc = /^#c=(\d{1,2})$/.exec(clean);
  if (mc) return { type: 'join', channel: mc[1]!.padStart(2, '0') };
  
  /* Secret text is matched loosely: crypto decides validity, so a
     hand-typed or mangled link still prefills its channel instead of
     dropping the user on a blank join form. */
const link = /^#(\d{1,2})\.([^\s/]+)$/.exec(clean);
  if (link) {
    const ch = (link[1] ?? '').padStart(2, '0');
    const secret = normalizeRoomSecret(link[2] ?? '');
    if (isValidRoomSecret(secret)) return { type: 'radio', channel: ch, secret };
    return { type: 'join', channel: ch };
  }
  
  const bare = /^#(\d{1,2})$/.exec(clean);
  if (bare) return { type: 'join', channel: (bare[1] ?? '').padStart(2, '0') };
  
  return { type: 'join' };
}

export function buildRadioHash(channel: string, secret: string): string {
  return `#${channel}.${secret}`;
}

export function buildJoinHash(channel: string): string {
  return `#c=${channel}`;
}