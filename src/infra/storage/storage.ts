/* ═══════════════════════════════════════════════════════════════
   infra/storage/storage.ts — the only place that touches Web Storage.

   Every access is guarded: Firefox private mode throws on the first
   property access, and a quota error must never take the radio down.
   dom.ts used to carry a byte-identical second copy of these six
   functions; this is the single copy now.
   ═══════════════════════════════════════════════════════════════ */

import { StoragePort } from '../../domain/session/types.js';

export function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota: persistence skipped */ }
}
export function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* noop */ }
}
export function safeSessGet(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
export function safeSessSet(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch { /* noop */ }
}
export function safeSessRemove(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* noop */ }
}

/** The session layer's structural port, over the same storage. */
export class LocalStorage implements StoragePort {
  get = safeGet;
  set = safeSet;
  remove = safeRemove;
  getSession = safeSessGet;
  setSession = safeSessSet;
  removeSession = safeSessRemove;
}

export const storage = new LocalStorage();
