/* app/gesture/gesture-unlock.ts — gesture-based audio context unlock. */

import { Sfx } from '../../domain/audio/sfx.js';
import { resumeContext } from '../../domain/audio/silentTrack.js';
import { Mesh } from '../../domain/mesh/mesh.js';

export interface GestureUnlockDeps {
  sfx: Sfx;
  mesh: Mesh;
  replayAudio: () => void;
}

export function initGestureUnlock(deps: GestureUnlockDeps): void {
  const { sfx, mesh, replayAudio } = deps;

  /* The mesh redial work is a RECOVERY attempt, not an unlock. Running it
     per event made every tap (and every auto-repeated keydown, ~30/s) fire
     up to 7 fresh RTCPeerConnections plus a leg-teardown pass — leg churn
     on the wire, beeps from linkOpen/linkLost, and broker pressure that
     earns HTTP 429. One sweep per gesture, plus the single 350ms
     follow-up: on engines whose AudioContext unlocks asynchronously
     (WebKit) the first pass finds it still locked and `_dialListen` bails
     with AUDIO NOT READY, so the follow-up is what actually dials. */
  let swept = false;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  function sweep(): void {
    try { mesh.retryPendingDials(); } catch { /* noop */ }
    try { mesh.redialLockedLegs(); } catch { /* noop */ }
  }
  function unlock(): void {
    /* sfx.unlock / resumeContext / replayAudio are idempotent — they
       resume or re-play an existing context, never create churn. */
    try { sfx.unlock(); } catch { /* noop */ }
    resumeContext();
    try { replayAudio(); } catch { /* noop */ }
    if (swept) return;
    swept = true;
    sweep();
    if (sweepTimer != null) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => { sweepTimer = null; sweep(); }, 350);
  }

  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', (ev) => { if (!ev.repeat) unlock(); }, { capture: true, passive: true });
}