/* infra/storage/storage.ts — localStorage/sessionStorage implementations. */

import { StoragePort } from '../../domain/session/types.js';

export class LocalStorage implements StoragePort {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* quota */ }
  }
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  }
  getSession(key: string): string | null {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }
  setSession(key: string, value: string): void {
    try { sessionStorage.setItem(key, value); } catch { /* quota */ }
  }
  removeSession(key: string): void {
    try { sessionStorage.removeItem(key); } catch { /* noop */ }
  }
}

export const storage = new LocalStorage();