/* ═══════════════════════════════════════════════════════════════
   WLK-1 GHOSTCOM — bootstrap.
   Wire-up only; all logic lives in domain/app/infra/ui layers.
   ═══════════════════════════════════════════════════════════════ */

import '@fontsource/vt323/latin-400.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-700.css';
import './styles/main.css';

import { CONFIG } from './config.js';
import { PowerManager } from './domain/battery.js';
import { Mesh } from './domain/mesh/mesh.js';
import { MicManager } from './domain/audio/mic.js';
import { Sfx } from './domain/audio/sfx.js';
import { E2EE, deriveRawGroupKey } from './domain/security/e2ee.js';
import {
  generateRoomSecret,
  isValidRoomSecret,
  normalizeRoomSecret,
  parseChannelHash,
  buildShareLink,
  deriveSecretFromPassphrase,
  passphraseStrength,
} from './domain/crypto/crypto.js';
import { storage } from './infra/storage/storage.js';
import { log, toast, fit as fitViewport } from './infra/dom/dom.js';
import { state } from './domain/state/state.js';
import { SessionService } from './app/session/session-service.js';
import { initRouter } from './app/router/router-service.js';
import { initGestureUnlock } from './app/gesture/gesture-unlock.js';
import { createLoop } from './app/radio/voice-loop.js';
import { createPTT } from './app/radio/ptt.js';
import { initRemoteAudio } from './app/radio/remote-audio.js';
import { bootSequence, matrixRain, showHintOnce, fit as fitShell } from './ui/components/boot-screen.js';
import { init as initJoinScreen, prefillJoin, clearWords } from './ui/components/join-screen.js';
import { init as initSettingsScreen, refresh as refreshSettings } from './ui/components/settings-screen.js';
import { init as initKeypad } from './ui/components/keypad.js';
import { init as initVolume, getLevel } from './ui/components/volume-slider.js';
import { init as initPeerChips } from './ui/components/peer-chips.js';
import { init as initLcd, clearDigits } from './ui/components/lcd.js';
import { init as initHint } from './ui/components/hint-modal.js';
import { pushRecent } from './ui/components/recent-rooms.js';
import { micTest, setMicManager } from './app/audio/mic-test.js';
import { shareChannel } from './app/session/share.js';

/* ── instantiate core services ──────────────────────────────── */
const sfx = new Sfx({ log });
const mic = new MicManager({ log });
const power = new PowerManager({ log });
const mesh = new Mesh({ sfx, mic, log, config: CONFIG });

setMicManager(mic);

/* ── radio loop + remote audio sink ─────────────────────────── */
const loop = createLoop({ sfx, onSuspend: () => sfx.suspend() });
const remoteAudio = initRemoteAudio({ sfx, loop, getVolume: getLevel });

/* ── session service (owns session state machine) ───────────── */
const session = new SessionService({
  mesh,
  e2ee: {
    supported: () => E2EE.supported(),
    deriveRawGroupKey,
    create: (rawKey: Uint8Array, logFn: (msg: string, kind?: string) => void) => new E2EE(rawKey, logFn),
  },
  mic: { release: () => mic.release() },
  crypto: {
    generateRoomSecret,
    isValidRoomSecret,
    normalizeRoomSecret,
    parseChannelHash,
    buildShareLink,
    deriveSecretFromPassphrase,
    passphraseStrength,
  },
  storage,
  ui: {
    showScreen,
    showHintOnce,
    joinError: (msg) => toast(msg),
    toast,
    syncRadioHash: (c, s) => history.replaceState(null, '', `#${c}.${s}`),
    prefillJoin: (ch) => prefillJoin(ch),
    clearWords,
  },
  log,
  config: { maxTxMs: CONFIG.maxTxMs },
});

/* ── UI wiring ─────────────────────────────────────────────── */
let currentScreen: 'radio' | 'join' | 'settings' = 'join';

/* Pure view swap. Session teardown is session-owned (router 'join'
   route → session.leave()), never triggered from here. */
function showScreen(name: 'radio' | 'join' | 'settings'): void {
  currentScreen = name;
  for (const [k, id] of Object.entries({ radio: 'view-radio', join: 'view-join', settings: 'view-settings' })) {
    document.getElementById(id)?.classList.toggle('hidden', k !== name);
  }
  const shown = document.getElementById({ radio: 'view-radio', join: 'view-join', settings: 'view-settings' }[name]);
  /* focus a button, never a text/range input — the keypad ignores keydown
     from inputs, so parking focus on the volume slider would kill every
     keyboard shortcut (digits, m/s/l, Escape) until the user clicks away */
  const target = shown?.querySelector('button:not([disabled])');
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

initJoinScreen({
  onJoin: (ch, sec, persist) => session.initFromJoin(ch, sec, persist),
  onOpenSettings: () => { location.hash = '#settings'; },
});
initSettingsScreen({
  onBack: () => {
    const s = session.getState();
    if (s.phase === 'joined' && s.channel && s.secret) location.hash = `#${s.channel}.${s.secret}`;
    else location.hash = '#';
  },
  onNewIdentity: () => session.newIdentity(generateRoomSecret),
});
initKeypad({
  sfx,
  onDial: async (ch) => {
    const s = session.getState();
    if (s.phase === 'joined' && s.channel === ch) { clearDigits(); return; }
    log(`CH ${ch} DIALED — FRESH KEY (NOT SAVED)`, 'sys');
    /* dialing from the radio is a REJOIN — a screen-join is refused while
       joined and would silently corrupt the phase under a live radio */
    const ok = await session.rejoin(ch, generateRoomSecret(), false);
    if (!ok) return;
    /* only a landed dial earns its recent entry — a failed dial must not
       downgrade a saved-key pointer for this channel */
    pushRecent(ch, null);
    clearDigits();
  },
  onSettings: () => { location.hash = '#settings'; },
  onLeave: () => {
    if (location.hash && location.hash !== '#') location.hash = '#';
    else void session.leave();
  },
});
initVolume({ onLevel: (v) => remoteAudio.setVolume(v) });
initPeerChips();
initLcd();
initHint();

/* ── PTT (button + Space/T + focused Enter), loop taps ──────── */
const ptt = createPTT({
  mesh,
  mic,
  sfx,
  power,
  config: CONFIG,
  isRadioActive: () => currentScreen === 'radio',
  onAnalyser: (stream) => {
    const tap = remoteAudio.analyserFor(stream);
    if (tap) loop.registerTx(tap.an, tap.src);
  },
  onTxEnd: () => loop.clearTx(),
});

/* ── power ──────────────────────────────────────────────────── */
power.init();
power.onBattery((level, charging) => {
  const el = document.getElementById('batt');
  if (el) el.textContent = `PWR ${Math.round(level * 100)}%${charging ? ' CHG' : ''}`;
});

/* ── gesture unlock (first tap/key) ─────────────────────────── */
initGestureUnlock({
  sfx,
  mesh,
  replayAudio: remoteAudio.replayAudio,
});

/* ── boot theater ───────────────────────────────────────────── */
document.fonts.ready.then(() => document.body.classList.add('fonts-ready')).catch(() => document.body.classList.add('fonts-ready'));
setTimeout(() => document.body.classList.add('fonts-ready'), 1500);   // font race backstop
bootSequence(['MEM OK', `CRYPTO ${E2EE.supported() ? 'E2EE-READY' : 'SRTP'}`, 'MIC COLD']);
matrixRain();
fitShell();
fitViewport();
window.addEventListener('resize', () => { fitShell(); fitViewport(); }, { passive: true });

/* PWA */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  /* updateViaCache: 'none' — otherwise the browser may serve a stale sw.js
     from the HTTP cache and a deploy can appear to do nothing for hours.
     BASE_URL-relative so GitHub Pages subpath hosting still finds the SW. */
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' }).catch(() => {});
}

log(`WLK-1 INIT — GHOSTCOM ONLINE — ${E2EE.supported() ? 'E2EE SUPPORTED' : 'SRTP ONLY ON THIS BROWSER'}`, 'sys');

/* Route on load (hash → session → screen) */
initRouter({
  session,
  showScreen,
  refreshSettings,
  prefillJoin: (ch) => prefillJoin(ch),
});

/* Test/debug surface (e2e drives the mesh through this) */
Object.assign(window, { mesh, session, mic, sfx, power, ptt, loop, state, micTest, shareChannel });

export { session, mesh, mic, sfx, power };
