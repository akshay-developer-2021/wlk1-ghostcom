/* core/state.js — tiny reactive store. No framework, ~40 lines.
   Everything UI + mesh needs to know lives here; modules subscribe. */

const listeners = new Map(); // key -> Set<fn>

export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

export function emit(key, value) {
  const set = listeners.get(key);
  if (set) for (const fn of set) { try { fn(value); } catch (e) { console.error('[wlk1] listener', key, e); } }
}

/* Central app state — mutated only through set() so listeners fire. */
export const state = {
  channel: null,
  secret: null,
  mySlot: -1,
  connected: false,          // signaling (broker) connected
  joined: false,             // slot claimed
  tx: false,
  micHot: false,
  powerSave: false,
  e2eeMode: 'off',           // 'e2ee' | 'dtls-only' | 'off'
  sas: null,                 // 4-char verification code
  peers: new Map(),          // slot -> {linked, speaking, quality}
};

export function set(patch) {
  let dirty = false;
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] !== v) { state[k] = v; dirty = true; emit(k, v); }
  }
  if (dirty) emit('change', state);
}

/* Peer bookkeeping helpers (Map values compared per-slot). */
export function setPeer(slot, patch) {
  const cur = state.peers.get(slot) || { linked: false, speaking: false, quality: 0 };
  const next = { ...cur, ...patch };
  const changed = Object.keys(next).some((k) => next[k] !== cur[k]);
  if (changed) { state.peers.set(slot, next); emit('peers', state.peers); emit('change', state); }
}

export function removePeer(slot) {
  if (state.peers.delete(slot)) { emit('peers', state.peers); emit('change', state); }
}

export function clearPeers() {
  if (state.peers.size) { state.peers.clear(); emit('peers', state.peers); emit('change', state); }
}

export const linkedSlots = () => [...state.peers.entries()].filter(([, p]) => p.linked).map(([s]) => s);
export const linkedCount = () => linkedSlots().length;
