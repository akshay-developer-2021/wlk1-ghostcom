/* app/gesture/gesture-unlock.ts — gesture-based audio context unlock. */

import { Sfx } from '../../domain/audio/sfx.js';
import { resumeContext, silentContextRunning } from '../../domain/audio/silentTrack.js';
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
     with AUDIO NOT READY, so the follow-up is what actually dials.
     And one MORE sweep once the context is actually running: a device that
     takes longer than that follow-up to open (Firefox/PulseAudio measured at
     well over it) left the tap that unlocked the audio without a dial, and
     the mesh holds no pending-slot memory to recover from — the pair simply
     never linked. After that the watchdog owns recovery, so taps stay cheap. */
  let swept = false;          // the gesture's own pass has run
  let sweptRunning = false;   // a pass has run with audio actually up — the last one
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  function sweep(): void {
    try { mesh.retryPendingDials(); } catch { /* noop */ }
    try { mesh.redialLockedLegs(); } catch { /* noop */ }
  }
  function unlock(): void {
    /* sfx.unlock / resumeContext / replayAudio are idempotent — they
       resume or re-play an existing context, never create churn. */
    try { sfx.unlock(); } catch { /* noop */ }
    const resuming = resumeContext();
    try { replayAudio(); } catch { /* noop */ }
    if (!swept) {
      swept = true;
      sweep();
      if (sweepTimer != null) clearTimeout(sweepTimer);
      sweepTimer = setTimeout(() => {
        sweepTimer = null;
        if (!sweptRunning) sweep();
      }, 350);
    }
    void resuming.then(() => {
      if (sweptRunning || !silentContextRunning()) return;  // still locked: the next tap retries
      sweptRunning = true;
      sweep();
    });
  }

  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', (ev) => { if (!ev.repeat) unlock(); }, { capture: true, passive: true });
}