/* core/state.ts — tiny reactive store. No framework, ~40 lines.
   Everything UI + mesh needs to know lives here; modules subscribe. */

export type StateListener = (value: unknown) => void;

const listeners = new Map<string, Set<StateListener>>(); // key -> Set<fn>

export function on(key: string, fn: StateListener): () => void {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)?.add(fn);
  return () => { listeners.get(key)?.delete(fn); };
}

export function emit(key: string, value: unknown): void {
  const set = listeners.get(key);
  if (set) for (const fn of set) { try { fn(value); } catch (e) { console.error('[wlk1] listener', key, e); } }
}

export interface PeerInfo {
  linked: boolean;
  speaking: boolean;
  quality: number;
  stream?: MediaStream | null;
  [k: string]: unknown;
}

export type E2eeMode = 'off' | 'e2ee' | 'dtls-only' | 'e2ee-ready';

/* Central app state — mutated only through set() so listeners fire. */
export interface AppState {
  channel: string | null;
  secret: string | null;
  mySlot: number;
  connected: boolean;          // signaling (broker) connected
  joined: boolean;             // slot claimed
  tx: boolean;
  micHot: boolean;
  powerSave: boolean;
  screenOn: boolean;
  e2eeMode: E2eeMode | string;
  sas: string | null;          // 4-char verification code
  peers: Map<number, PeerInfo>; // slot -> {linked, speaking, quality}
  [k: string]: unknown;
}

export const state: AppState = {
  channel: null,
  secret: null,
  mySlot: -1,
  connected: false,          // signaling (broker) connected
  joined: false,             // slot claimed
  tx: false,
  micHot: false,
  powerSave: false,
  screenOn: true,
  e2eeMode: 'off',           // 'e2ee' | 'dtls-only' | 'off'
  sas: null,                 // 4-char verification code
  peers: new Map(),          // slot -> {linked, speaking, quality}
};

export function set(patch: Partial<AppState> & { [k: string]: unknown }): void {
  let dirty = false;
  for (const [k, v] of Object.entries(patch)) {
    if ((state as Record<string, unknown>)[k] !== v) {
      (state as Record<string, unknown>)[k] = v;
      dirty = true;
      emit(k, v);
    }
  }
  if (dirty) emit('change', state);
}

/* Peer bookkeeping helpers (Map values compared per-slot). */
export function setPeer(slot: number, patch: Partial<PeerInfo>): void {
  const cur: PeerInfo = state.peers.get(slot) ?? { linked: false, speaking: false, quality: 0 };
  const next: PeerInfo = { ...cur, ...patch };
  const changed = Object.keys(next).some((k) => next[k] !== cur[k]);
  if (changed) { state.peers.set(slot, next); emit('peers', state.peers); emit('change', state); }
}

export function removePeer(slot: number): void {
  if (state.peers.delete(slot)) { emit('peers', state.peers); emit('change', state); }
}

export function clearPeers(): void {
  if (state.peers.size) { state.peers.clear(); emit('peers', state.peers); emit('change', state); }
}

export const linkedSlots = (): number[] =>
  [...state.peers.entries()].filter(([, p]) => p.linked).map(([s]) => s);
export const linkedCount = (): number => linkedSlots().length;
