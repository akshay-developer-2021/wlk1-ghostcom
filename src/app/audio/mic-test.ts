/* app/audio/mic-test.ts — mic verification. */

import { toast, log, setSync } from '../../infra/dom/dom.js';
import { state } from '../../domain/state/state.js';
import { MicManager } from '../../domain/audio/mic.js';

let mic: MicManager | null = null;

export function setMicManager(m: MicManager): void { mic = m; }

export async function micTest(): Promise<void> {
  if (!mic || state.tx || mic.hot) { toast('BUSY — MIC IN USE'); return; }
  try {
    const { stream, generation } = await mic.acquire();
    if (generation !== mic.generation) { toast('BUSY — MIC IN USE'); return; }
    setSync('MIC PATH VERIFIED — RELEASING…', 'on');
    stream.getTracks().forEach((t) => t.stop());
    mic.release();
    setSync('MIC PATH VERIFIED — HW SLEEPING', 'on');
    toast('MIC OK — SLEEPS TILL PTT');
    log('MIC VERIFY PASS — HARDWARE OFF', 'sys');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    /* our own release cancelled the acquire — not a permission problem */
    if (/CANCELLED/.test(msg)) { toast('BUSY — MIC IN USE'); return; }
    setSync('MIC BLOCKED — CHECK LOCK ICON', 'warn');
    log(`MIC DENIED — ${msg}`, 'warn');
    toast('⚠ ALLOW MIC');
  }
}