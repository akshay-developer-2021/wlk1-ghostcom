/* ui/components/settings-screen.ts — settings screen controller. */

import { $, safeGet, safeSet, toast, log, copyAllLogs } from '../../infra/dom/dom.js';
import { CONFIG, BROKER_STORE_KEY } from '../../config.js';
import { E2EE } from '../../domain/security/e2ee.js';
import { generateRoomSecret } from '../../domain/crypto/crypto.js';
import { set, state, clearPeers } from '../../domain/state/state.js';

export interface SettingsCallbacks {
  onBack: () => void;
  onNewIdentity: () => Promise<void>;
}

function browserTag(): string {
  const ua = navigator.userAgent;
  if (/Firefox\/\d+/.test(ua)) return `FIREFOX ${/Firefox\/(\d+)/.exec(ua)?.[1] ?? ''}`.trim();
  if (/Edg\/\d+/.test(ua)) return 'EDGE (CHROMIUM)';
  if (/Chrome\/\d+/.test(ua)) return 'CHROME/CHROMIUM';
  if (/Safari\/\d+/.test(ua)) return 'SAFARI';
  return 'UNKNOWN BROWSER';
}

export function init(callbacks: SettingsCallbacks): void {
  $('setSave')?.addEventListener('click', () => {
    const host = ($('setHost') as HTMLInputElement | null)?.value.trim() ?? '';
    let broker: Record<string, unknown> = {};
    try {
      const raw = safeGet(BROKER_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object' && parsed !== null) broker = { ...(parsed as Record<string, unknown>) };
      }
    } catch { /* corrupt */ }
    if (host) broker.host = host;
    else delete broker.host;
    safeSet(BROKER_STORE_KEY, JSON.stringify(broker));
    toast(host ? `BROKER SAVED — RELOAD TO APPLY` : 'BROKER CLEARED — RELOAD TO APPLY');
    log(`BROKER OVERRIDE ${host ? `SET → ${host}` : 'CLEARED'}`, 'sys');
  });

  $('setReload')?.addEventListener('click', () => location.reload());
  $('setBack')?.addEventListener('click', callbacks.onBack);
  $('setCopyLogs')?.addEventListener('click', copyAllLogs);
  $('newIdentityBtn')?.addEventListener('click', callbacks.onNewIdentity);
}

export function refresh(): void {
  const host = $('setHost') as HTMLInputElement | null;
  if (host && document.activeElement !== host) {
    let saved = '';
    try {
      const raw = safeGet(BROKER_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object' && parsed !== null &&
          typeof (parsed as { host?: unknown }).host === 'string') {
          saved = (parsed as { host: string }).host;
        }
      }
    } catch { /* keep default */ }
    host.value = saved || CONFIG.signaling.host || '';
  }

  const turnNote = $('turnNote');
  if (turnNote) {
    turnNote.textContent =
      `ACTIVE ICE: ${CONFIG.iceServers.length} SERVER${CONFIG.iceServers.length === 1 ? '' : 'S'}` +
      ' (OVERRIDE VIA window.WLK1_CONFIG.iceServers OR STORED wlk1-turn JSON — APPLIES ON RELOAD)';
  }

  const e2ee = $('diagE2ee');
  if (e2ee) e2ee.textContent = E2EE.supported() ? 'E2EE-READY' : 'SRTP-ONLY';

  const brow = $('diagBrowser');
  if (brow) brow.textContent = browserTag();
}