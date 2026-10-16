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

  function unlock(): void {
    try { sfx.unlock(); } catch { /* noop */ }
    resumeContext();
    try { replayAudio(); } catch { /* noop */ }
    try { mesh.retryPendingDials(); } catch { /* noop */ }
    try { mesh.redialLockedLegs(); } catch { /* noop */ }
    setTimeout(() => {
      try { mesh.retryPendingDials(); } catch { /* noop */ }
      try { mesh.redialLockedLegs(); } catch { /* noop */ }
    }, 350);
  }

  window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, { capture: true, passive: true });
}