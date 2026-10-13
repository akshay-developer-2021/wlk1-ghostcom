/* ═══════════════════════════════════════════════════════════════
   WLK-1 GHOSTCOM — production main.
   Wire-up only; all logic lives in domain modules.

   URL contract (hash router):
   · "#CH.SECRET" (e.g. #22.K7Q9…) → radio immediately (back-compat
     share links; secret normalized then validated).
   · "#c=22" or bare/empty hash     → Join screen (no auto-join into
     dead rooms; channel prefilled when parseable).
   · "#settings"                    → Settings screen.
   Radio init (initSession → join) runs only when entering radio.
   ═══════════════════════════════════════════════════════════════ */

import '@fontsource/vt323/latin-400.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-700.css';
import './styles/main.css';

import { CONFIG, BROKER_STORE_KEY } from './config.js';
import {
  generateRoomSecret, isValidRoomSecret, normalizeRoomSecret,
  parseChannelHash, buildShareLink, deriveSecretFromPassphrase,
} from './core/crypto.js';
export { deriveSecretFromPassphrase }; // KDF lives in core/crypto.ts; re-exported for any importer
import { E2EE, deriveRawGroupKey } from './security/e2ee.js';
import { set, state, on, linkedCount } from './core/state.js';
import type { PeerInfo } from './core/state.js';
import { PowerManager } from './core/battery.js';
import { MicManager } from './audio/mic.js';
import { Sfx, HAPTIC } from './audio/sfx.js';
import { Mesh, onQuality, onCrypto } from './webrtc/mesh.js';
import { resumeSilentContext } from './audio/silentTrack.js';
import { $, log, toast, setSync, countPkt } from './ui/dom.js';
import { safeGet, safeSet, safeRemove, safeSessGet, safeSessSet, safeSessRemove } from './ui/dom.js';
import { createPTT } from './ui/ptt.js';
import { createLoop } from './ui/loop.js';
import { bootSequence, matrixRain, showHintOnce, fit } from './ui/boot.js';

/* ── instantiate the machine room ─────────────────────────── */
const sfx = new Sfx({ log });
const mic = new MicManager({ warmWindowMs: CONFIG.warmWindowMs, log });
const power = new PowerManager({ log });
const loop = createLoop({ sfx, onSuspend: () => sfx.suspend() });

/* E2EE is initialized once the room secret is known (see rekeyE2EE). */
let e2ee: E2EE | null = null;
set({ e2eeMode: E2EE.supported() ? 'e2ee-ready' : 'dtls-only' });

/** Adapter: mesh.ts (webrtc workstream, mid-conversion) currently infers its
    `log` option as () => void from its `log = () => {}` default. All-optional
    params stay assignable now and once it declares LogFn properly. */
const logFn = (msg?: string, kind?: string): void => { log(msg ?? '', kind); };

/** mesh.ts hasn't declared its runtime fields yet (peer/e2ee were dynamic
    expando in the JS original). Structural access until it does. */
interface MeshRuntime {
  peer: unknown;
  e2ee: E2EE | null;
}

const mesh = new Mesh({ sfx, mic, e2ee, log: logFn, config: CONFIG });
const meshRt: MeshRuntime = mesh as unknown as MeshRuntime;
const ptt = createPTT({
  mesh, mic, sfx, power, config: CONFIG,
  onAnalyser: (s: MediaStream) => { const t = analyserFor(s); loop.registerTx(t.an, t.src); },
  onTxEnd: () => loop.clearTx(),
  isRadioActive: () => routeName === 'radio',
});

power.init();
power.onBattery((level, charging) => {
  const el = $('batt');
  if (el) el.textContent = `PWR ${Math.round(level * 100)}%${charging ? ' CHG' : ''}`;
});

/* ── screens + hash router ────────────────────────────────── */
type RouteName = 'radio' | 'join' | 'settings';
type JoinMode = 'link' | 'pass';

let routeName: RouteName = 'join';
let radioStarted = false;   // initSession runs once, on first radio entry
let joinMode: JoinMode = 'link';
/* Last join's remember-me choice. Gates dial/share persistence so a
   no-persist session never silently writes keys to localStorage. */
let sessionPersist = false;

const VIEWS: Record<RouteName, string> = { radio: 'view-radio', join: 'view-join', settings: 'view-settings' };

function showScreen(name: RouteName): void {
  if (routeName === 'radio' && name !== 'radio') clearWords(); // leaving the room: words never linger
  if (routeName === 'radio' && name === 'join') {
    // Leaving the room for Join: tear down live legs first so no ghost
    // legs survive, then the key never lingers in state or the URL.
    try { mesh.leave(); } catch { /* noop */ }
    set({ secret: null });
    const ch = typeof state.channel === 'string' && /^\d{2}$/.test(state.channel) ? state.channel : null;
    history.replaceState(null, '', ch ? `#c=${ch}` : '#');
  }
  routeName = name;
  for (const [k, id] of Object.entries(VIEWS) as [RouteName, string][]) {
    document.getElementById(id)?.classList.toggle('hidden', k !== name);
  }
  // Land keyboard users somewhere operable on the revealed screen.
  const shown = document.getElementById(VIEWS[name]);
  const target = shown?.querySelector(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  );
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

function pad2(raw: string): string {
  return raw.padStart(2, '0').slice(0, 2);
}

function validChannel(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return /^\d{1,2}$/.test(t) ? pad2(t) : null;
}

/** Route the current hash. Radio entry boots the session lazily. */
function route(): void {
  const raw = location.hash;
  const hash = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  if (/^#settings($|[?/])/.test(hash)) {
    showScreen('settings');
    refreshSettings();
    return;
  }
  const mc = /^#c=(\d{1,2})$/.exec(hash);
  if (mc) {
    prefillJoin(pad2(mc[1] ?? ''));
    showScreen('join');
    return;
  }
  const parsed = parseChannelHash(hash);
  if (parsed?.channel && parsed.secret) {
    // Full share link: normalize → validate BEFORE touching radio state.
    // Mutated/typed-by-hand secrets are rejected loudly, never minted.
    const norm = normalizeRoomSecret(parsed.secret);
    if (!isValidRoomSecret(norm)) {
      joinError('BAD KEY — CHECK LINK');
      log(`BAD KEY — REJECTED FOR CH ${parsed.channel} — CHECK LINK`, 'warn');
      prefillJoin(parsed.channel);
      showScreen('join');
      return;
    }
    if (radioStarted) {
      if (state.channel === parsed.channel && state.secret === norm) {
        showScreen('radio'); // same room: no-op, never rejoin
        return;
      }
      // In-session hash navigation to a DIFFERENT room → rejoin it.
      // Direct-hash-open semantics: the link key persists.
      log(`CH ${parsed.channel} FROM LINK`, 'sys');
      toast(`CH ${parsed.channel} FROM LINK — JOINED`);
      showScreen('radio');
      void joinRoom(parsed.channel, norm, true).then((ok) => { if (ok) syncRadioHash(); });
      return;
    }
    showScreen('radio');
    void initSession();
    return;
  }
  if (parsed?.channel && /^#\d{1,2}$/.test(hash)) {
    // Bare "#22" (no secret): prefill Join, never auto-join a dead room.
    prefillJoin(parsed.channel);
    showScreen('join');
    return;
  }
  prefillJoin(state.channel && /^\d{2}$/.test(state.channel) ? state.channel : null);
  showScreen('join');
}

function prefillJoin(channel: string | null): void {
  const input = $('joinChannel');
  if (input instanceof HTMLInputElement && channel && document.activeElement !== input) {
    input.value = channel;
  }
  renderRecents();
}

/* ── session: single join path (set → rekey → join) ───────── */
interface JoinResult {
  ok?: boolean;
  reason?: string;
}

async function joinRoom(channel: string, secret: string, persist: boolean): Promise<boolean> {
  const norm = normalizeRoomSecret(secret);
  if (!isValidRoomSecret(norm)) {
    // REJECT: never mint a fresh key for a bad link, never overwrite good
    // saved keys, never sync the hash.
    joinError('BAD KEY — CHECK LINK');
    log(`BAD KEY — REJECTED FOR CH ${channel} — CHECK LINK`, 'warn');
    return false;
  }
  sessionPersist = persist;
  set({ channel, secret: norm });
  await rekeyE2EE();                       // keys ready BEFORE any leg dials
  if (persist) {
    safeSet('wlk1-ch', channel);
    safeSet('wlk1-key', norm);
  }
  digitBuf = channel.split('');
  updateDisplay();
  const r = (await mesh.join(channel)) as JoinResult | undefined;
  if (r?.ok) { mesh.startQualityPolling(); countPkt(); return true; }
  if (r?.reason === 'full') toast('CHANNEL FULL — ALL SLOTS TAKEN');
  return false;
}

/** First radio entry: hash link wins, otherwise state/saved secret. */
async function initSession(): Promise<void> {
  if (radioStarted) return;
  radioStarted = true;
  const hashRaw = location.hash;
  const fromHash = parseChannelHash(hashRaw.endsWith('.') ? hashRaw.slice(0, -1) : hashRaw);
  if (fromHash?.channel && fromHash.secret) {
    const norm = normalizeRoomSecret(fromHash.secret);
    if (!isValidRoomSecret(norm)) {
      joinError('BAD KEY — CHECK LINK');
      log(`BAD KEY — REJECTED FOR CH ${fromHash.channel} — CHECK LINK`, 'warn');
      prefillJoin(fromHash.channel);
      showScreen('join');
      return;
    }
    set({
      channel: fromHash.channel,
      secret: norm,
    });
    log(`CH ${fromHash.channel} FROM LINK`, 'sys');
    toast(`CH ${fromHash.channel} FROM LINK — JOINED`);
    showHintOnce();
    await joinRoom(fromHash.channel, norm, true);
    syncRadioHash();
    return;
  }
  const channel = (typeof state.channel === 'string' && /^\d{2}$/.test(state.channel))
    ? state.channel
    : (validChannel(safeGet('wlk1-ch')) ?? '22');
  const savedRaw = typeof state.secret === 'string' ? state.secret : (safeGet('wlk1-key') ?? '');
  const normSaved = normalizeRoomSecret(savedRaw);
  if (!isValidRoomSecret(normSaved)) {
    // No usable saved key and no link key: Join screen instead of minting
    // a silent fresh key nobody else holds.
    log('NO SAVED KEY — JOIN A CHANNEL FIRST', 'warn');
    prefillJoin(/^\d{2}$/.test(channel) ? channel : null);
    showScreen('join');
    return;
  }
  showHintOnce();
  await joinRoom(channel, normSaved, true);
  syncRadioHash();
}

/** Enter radio from the Join screen / recents (session path, not hash). */
async function enterRadio(channel: string, secret: string, persist: boolean): Promise<void> {
  const norm = normalizeRoomSecret(secret);
  if (!isValidRoomSecret(norm)) {
    joinError('BAD KEY — CHECK LINK');
    log(`BAD KEY — REJECTED FOR CH ${channel} — CHECK LINK`, 'warn');
    showScreen('join');
    return;
  }
  showScreen('radio');
  if (!radioStarted) {
    radioStarted = true;
    showHintOnce();
  }
  await joinRoom(channel, norm, persist);
  syncRadioHash();
}

/** Keep the URL shareable: reflect the live channel+secret in the hash.
    replaceState (not assignment) so Back never walks stale rooms. */
function syncRadioHash(): void {
  if (typeof state.channel === 'string' && typeof state.secret === 'string') {
    const want = `#${state.channel}.${state.secret}`;
    if (location.hash !== want) history.replaceState(null, '', want);
  }
}

async function rekeyE2EE(): Promise<void> {
  if (!state.secret) return;
  if (!E2EE.supported()) { set({ e2eeMode: 'dtls-only' }); return; }
  try {
    if (e2ee) e2ee.destroy();
    const raw = await deriveRawGroupKey(crypto.subtle, state.secret as string);
    e2ee = new E2EE(raw, log);
    meshRt.e2ee = e2ee;
    set({ e2eeMode: 'e2ee' });
    log('E2EE LAYER ACTIVE — AES-GCM FRAME CRYPTO', 'sys');
  } catch (err) {
    set({ e2eeMode: 'dtls-only' });
    log(`E2EE UNAVAILABLE — ${err instanceof Error ? err.message : String(err)} — SRTP ONLY`, 'warn');
  }
}

/* ── passphrase → room secret ───────────────────────────────
   KDF lives in core/crypto.ts (deriveSecretFromPassphrase). Words live
   in sessionStorage only (see clearWords); only the DERIVED secret may
   persist via opt-in "remember". */
const PASS_STORE_KEY = 'wlk1-pass';

export function passphraseStrength(pw: string): { score: number; label: string } {
  const words = pw.trim().split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 16) score++;
  if (words >= 3) score++;
  if (words >= 4 || pw.length >= 24) score++;
  const label = score <= 1 ? 'WEAK' : score === 2 ? 'OK' : score === 3 ? 'GOOD' : 'STRONG';
  return { score, label };
}

/* ── recent rooms (derived secrets only, never passphrase words) */
interface RecentRoom {
  ch: string;
  secret: string | null;
  ts: number;
}
const RECENT_KEY = 'wlk1-recent';
const RECENT_MAX = 8;

function readRecents(): RecentRoom[] {
  try {
    const raw = safeGet(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    // Corrupt entries (bad channel, non-null secret that fails validation)
    // are dropped, never joined.
    return arr.filter((e): e is RecentRoom =>
      typeof e === 'object' && e !== null &&
      typeof (e as RecentRoom).ch === 'string' && /^\d{2}$/.test((e as RecentRoom).ch) &&
      ((e as RecentRoom).secret === null ||
        isValidRoomSecret(normalizeRoomSecret((e as RecentRoom).secret))));
  } catch {
    return [];
  }
}

function pushRecent(ch: string, secret: string | null): void {
  // Recents hold secrets only when persisting; anything corrupt degrades to
  // null (needs key) rather than joining a bad room.
  const clean = secret !== null && isValidRoomSecret(normalizeRoomSecret(secret))
    ? normalizeRoomSecret(secret) : null;
  const list = readRecents().filter((r) => r.ch !== ch);
  list.unshift({ ch, secret: clean, ts: Date.now() });
  if (list.length > RECENT_MAX) log('RECENT DROPPED OLDEST', 'sys');
  safeSet(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

function renderRecents(): void {
  const box = $('recentList');
  if (!box) return;
  const list = readRecents();
  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = 'NO RECENT ROOMS — JOIN ONE ABOVE';
    box.appendChild(empty);
    return;
  }
  for (const r of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-chip';
    const label = document.createElement('span');
    label.textContent = `CH ${r.ch}`;
    const sub = document.createElement('span');
    sub.className = 'recent-sub';
    sub.textContent = r.secret ? '· KEY SAVED' : '· NEEDS KEY';
    b.append(label, sub);
    b.addEventListener('click', () => {
      if (r.secret) void enterRadio(r.ch, r.secret, true);
      else {
        setJoinMode('pass');
        prefillJoin(r.ch);
        showScreen('join');
      }
    });
    box.appendChild(b);
  }
}

/* ── join screen wiring ───────────────────────────────────── */
/* Passphrase words live in sessionStorage only and are wiped on mode
   switch, room leave, new identity, and tab-hide (see clearWords). */
function clearWords(): void {
  safeSessRemove(PASS_STORE_KEY);
  const passEl = $('joinPass');
  if (passEl instanceof HTMLInputElement) passEl.value = '';
}

function setJoinMode(mode: JoinMode): void {
  if (mode !== joinMode) clearWords(); // words never survive a mode switch
  joinMode = mode;
  $('tabLink')?.classList.toggle('active', mode === 'link');
  $('tabPass')?.classList.toggle('active', mode === 'pass');
  $('tabLink')?.setAttribute('aria-selected', String(mode === 'link'));
  $('tabPass')?.setAttribute('aria-selected', String(mode === 'pass'));
  $('panelLink')?.classList.toggle('hidden', mode !== 'link');
  $('panelPass')?.classList.toggle('hidden', mode !== 'pass');
}

function joinError(msg: string): void {
  const el = $('joinErr');
  if (el) el.textContent = msg;
  if (msg) { toast(msg); setSync(msg, 'warn'); }
}

function setupJoin(): void {
  $('tabLink')?.addEventListener('click', () => setJoinMode('link'));
  $('tabPass')?.addEventListener('click', () => setJoinMode('pass'));

  const passInput = $('joinPass');
  if (passInput instanceof HTMLInputElement) {
    const saved = safeSessGet(PASS_STORE_KEY);
    if (saved) passInput.value = saved;
    passInput.addEventListener('input', () => {
      const { score, label } = passphraseStrength(passInput.value);
      const fill = $('passFill');
      const lab = $('passLabel');
      if (fill) {
        fill.style.width = `${(score / 4) * 100}%`;
        fill.dataset.level = String(score);
      }
      if (lab) lab.textContent = passInput.value ? label : '—';
    });
  }

  $('joinBtn')?.addEventListener('click', () => void doJoin());
  $('joinChannel')?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && e.key === 'Enter') void doJoin();
  });
  passInput?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && e.key === 'Enter') void doJoin();
  });
  $('joinSettings')?.addEventListener('click', () => { location.hash = '#settings'; });
  renderRecents();
}

async function doJoin(): Promise<void> {
  joinError('');
  const chRaw = $('joinChannel') instanceof HTMLInputElement
    ? ($('joinChannel') as HTMLInputElement).value : '';
  const channel = validChannel(chRaw);
  if (!channel) { joinError('ENTER A 2-DIGIT CHANNEL (00–99)'); return; }

  const btn = $('joinBtn');
  if (btn instanceof HTMLButtonElement) { btn.disabled = true; }
  // Remember-me governs BOTH join modes: only a checked box persists the
  // fresh/derived secret (and channel). Direct #CH.SECRET hash opens still
  // default to persist (see initSession/route).
  const remember = $('rememberMe') instanceof HTMLInputElement
    && ($('rememberMe') as HTMLInputElement).checked;

  try {
    if (joinMode === 'link') {
      const secret = generateRoomSecret();
      if (remember) {
        safeSet('wlk1-ch', channel);
        safeSet('wlk1-key', secret);
        pushRecent(channel, secret);
      } else {
        safeRemove('wlk1-ch');
        safeRemove('wlk1-key');
        pushRecent(channel, null);
      }
      log(`CH ${channel} MANUAL JOIN — FRESH KEY${remember ? '' : ' (NOT SAVED)'}`, 'sys');
      await enterRadio(channel, secret, remember);
    } else {
      const passEl = $('joinPass');
      const words = passEl instanceof HTMLInputElement ? passEl.value.normalize('NFKC').trim() : '';
      if (words.length < 4) { joinError('PASSPHRASE TOO SHORT — 4+ CHARS'); return; }
      // The meter is display-only; the floor is enforced here.
      if (passphraseStrength(words).score < 2) {
        joinError('PASSPHRASE TOO WEAK — 3+ WORDS OR 16+ CHARS');
        return;
      }
      if (btn instanceof HTMLButtonElement) btn.textContent = 'DERIVING…';
      let secret: string;
      try {
        secret = await deriveSecretFromPassphrase(words, channel);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        joinError(`JOIN FAILED — ${msg}`);
        log(`KDF FAILURE — ${msg}`, 'warn');
        return;
      }
      safeSessSet(PASS_STORE_KEY, words); // words: session only, never localStorage
      if (remember) {
        // Opt-in: persist the DERIVED secret, never the words.
        safeSet('wlk1-ch', channel);
        safeSet('wlk1-key', secret);
        pushRecent(channel, secret);
      } else {
        safeRemove('wlk1-ch');
        safeRemove('wlk1-key');
        pushRecent(channel, null);
      }
      log(`CH ${channel} PASSPHRASE JOIN — KEY DERIVED${remember ? '' : ' (NOT SAVED)'}`, 'sys');
      await enterRadio(channel, secret, remember);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    joinError(`JOIN FAILED — ${msg}`);
    log(`JOIN FAILED — ${msg}`, 'warn');
  } finally {
    if (btn instanceof HTMLButtonElement) {
      btn.disabled = false;
      btn.textContent = '▶ JOIN CHANNEL';
    }
  }
}

/* ── settings screen wiring ───────────────────────────────── */
function refreshSettings(): void {
  const host = $('setHost');
  if (host instanceof HTMLInputElement && document.activeElement !== host) {
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

function browserTag(): string {
  const ua = navigator.userAgent;
  if (/Firefox\/\d+/.test(ua)) return `FIREFOX ${/Firefox\/(\d+)/.exec(ua)?.[1] ?? ''}`.trim();
  if (/Edg\/\d+/.test(ua)) return 'EDGE (CHROMIUM)';
  if (/Chrome\/\d+/.test(ua)) return 'CHROME/CHROMIUM';
  if (/Safari\/\d+/.test(ua)) return 'SAFARI';
  return 'UNKNOWN BROWSER';
}

function setupSettings(): void {
  $('setSave')?.addEventListener('click', () => {
    const host = $('setHost') instanceof HTMLInputElement
      ? ($('setHost') as HTMLInputElement).value.trim() : '';
    // Merge into the stored object: the screen edits host only, so any
    // previously stored secure/port/path/key fields must survive the save.
    let broker: Record<string, unknown> = {};
    try {
      const raw = safeGet(BROKER_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object' && parsed !== null) broker = { ...(parsed as Record<string, unknown>) };
      }
    } catch { /* corrupt stored broker: save host alone */ }
    if (host) broker['host'] = host;
    else delete broker['host'];
    safeSet(BROKER_STORE_KEY, JSON.stringify(broker));
    toast(host ? `BROKER SAVED — RELOAD TO APPLY` : 'BROKER CLEARED — RELOAD TO APPLY');
    log(`BROKER OVERRIDE ${host ? `SET → ${host}` : 'CLEARED'}`, 'sys');
  });
  $('setReload')?.addEventListener('click', () => location.reload());
  $('setBack')?.addEventListener('click', () => {
    if (radioStarted && typeof state.channel === 'string' && typeof state.secret === 'string') {
      location.hash = `#${state.channel}.${state.secret}`;
      showScreen('radio');
    } else {
      location.hash = '#';
      showScreen('join');
    }
  });
  $('setCopyLogs')?.addEventListener('click', copyAllLogs);
  $('newIdentityBtn')?.addEventListener('click', () => void newIdentity());
}

async function newIdentity(): Promise<void> {
  clearWords();
  const fresh = generateRoomSecret();
  set({ secret: fresh });
  if (sessionPersist) safeSet('wlk1-key', fresh);
  log('NEW IDENTITY — OLD LINK DEAD', 'warn');
  if (radioStarted && typeof state.channel === 'string') {
    try { mesh.leave(); } catch { /* noop */ }
    await joinRoom(state.channel, fresh, sessionPersist);
    syncRadioHash();
    toast('NEW IDENTITY — REJOINED, OLD LINK DEAD');
  } else {
    toast('NEW IDENTITY READY');
  }
}

/* ── keypad: rolling dial, always responsive ──────────────── */
let digitBuf: string[] = [];
function updateDisplay(): void {
  const entering = digitBuf.length === 1;
  const ch = digitBuf.length ? digitBuf.join('') : (state.channel || '--');
  const chanEl = $('chan');
  if (chanEl) chanEl.textContent = `CH ${ch}${entering ? '_' : ''}`;
  const freqEl = $('freq');
  if (freqEl) freqEl.textContent = `152.${String(ch).padStart(3, '0')}`;
  $('lcd')?.classList.toggle('entering', entering);
}

async function enterDigit(n: number): Promise<void> {
  sfx.key();
  sfx.haptic(HAPTIC.key);
  if (digitBuf.length >= 2) digitBuf = digitBuf.slice(1);   // ROLLING dial
  digitBuf.push(String(n));
  updateDisplay();
  if (digitBuf.length === 2) await dial(digitBuf.join(''));
}

async function dial(channel: string): Promise<void> {
  if (meshRt.peer && state.channel === channel) return;
  const norm = normalizeRoomSecret(typeof state.secret === 'string' ? state.secret : '');
  if (!isValidRoomSecret(norm)) {
    joinError('BAD KEY — CHECK LINK');
    log(`BAD KEY — DIAL TO CH ${channel} REFUSED — CHECK LINK`, 'warn');
    return;
  }
  const ok = await joinRoom(channel, norm, sessionPersist);
  if (ok) {
    // Dial is explicit: the channel follows even in no-persist sessions,
    // but the secret is written only when the session persists.
    if (!sessionPersist) safeSet('wlk1-ch', channel);
    syncRadioHash();
  }
}

function setupKeypad(): void {
  document.querySelectorAll('.key[data-digit]').forEach((k) => {
    if (k instanceof HTMLElement) {
      k.addEventListener('click', () => void enterDigit(+(k.dataset['digit'] ?? 0)));
    }
  });
  $('keyDel')?.addEventListener('click', () => { digitBuf.pop(); sfx.key(); updateDisplay(); });
  $('keyMic')?.addEventListener('click', () => void micTest());
  $('keyShare')?.addEventListener('click', shareChannel);
  $('keySettings')?.addEventListener('click', () => { location.hash = '#settings'; });

  const inField = (t: EventTarget | null): boolean =>
    !!(t instanceof HTMLElement && t.closest('input:not([type=range]), textarea, select, [contenteditable="true"]'));
  const hintOpen = (): boolean => document.getElementById('hint')?.classList.contains('show') ?? false;
  const toggleHint = (show?: boolean): void => {
    const h = $('hint');
    if (!h) return;
    const next = show ?? !h.classList.contains('show');
    h.classList.toggle('show', next);
  };

  /* digits + utilities. Space/Enter PTT lives in ptt.js (no double-bind).
     Shortcuts are radio-only; on Join/Settings only Esc is honored. */
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.repeat || inField(e.target)) return;
    // Hint modal open: every radio shortcut is dead except Esc (close)
    // and H/? (toggle). Nothing else may fire underneath the dialog.
    if (hintOpen()) {
      if (e.key === 'Escape') { toggleHint(false); return; }
      if (e.key.toLowerCase() === 'h' || e.key === '?') { toggleHint(); return; }
      return;
    }
    const k = e.key;
    if (routeName !== 'radio') {
      if (k === 'Escape') {
        // Fallback: show the screen directly AND set the hash —
        // hashchange may not fire when the hash is unchanged.
        if (radioStarted) {
          if (typeof state.channel === 'string' && typeof state.secret === 'string') {
            location.hash = `#${state.channel}.${state.secret}`;
          }
          showScreen('radio');
        }
      }
      return;
    }
    // Space/Enter PTT lives in ptt.ts: never swallow Space here — in
    // particular not when #volSlider is focused.
    if (k === ' ' || k === 'Spacebar') return;
    if (/^[0-9]$/.test(k) && document.activeElement?.tagName !== 'INPUT') { void enterDigit(+k); return; }
    if (k === 'Backspace') { if (!digitBuf.length) return; digitBuf.pop(); updateDisplay(); return; }
    if (k === 'Escape') {
      if (hintOpen()) toggleHint(false);
      else { digitBuf = []; updateDisplay(); }
      return;
    }
    const lk = k.toLowerCase();
    if (lk === 't') { e.preventDefault(); ptt.press('t'); return; } // laptop PTT alt
    if (lk === 'm') { void micTest(); return; }
    if (lk === 's') { shareChannel(); return; }
    if (lk === 'l') { copyAllLogs(); return; }
    if (lk === 'h' || k === '?') { toggleHint(); return; }
    if ((k === 'ArrowUp' || k === '+' || k === '=') && document.activeElement?.id !== 'volSlider') {
      e.preventDefault(); nudgeVolume(5); return;
    }
    if ((k === 'ArrowDown' || k === '-' || k === '_') && document.activeElement?.id !== 'volSlider') {
      e.preventDefault(); nudgeVolume(-5); return;
    }
  });
  window.addEventListener('keyup', (e: KeyboardEvent) => {
    // Mirror the keydown guards so a held T can't stick when the dialog
    // opens mid-hold or focus sits in a field.
    if (e.repeat || inField(e.target)) return;
    if (hintOpen()) return;
    if (routeName !== 'radio') return;
    if (e.key.toLowerCase() === 't') ptt.release('t');
  });
}

/* MIC key = verify hardware path, then HARD RELEASE (PoC leak fix) */
async function micTest(): Promise<void> {
  if (state.tx || mic.hot) { toast('BUSY — MIC IN USE'); return; }
  try {
    const { stream, generation } = await mic.acquire();
    if (generation !== mic.generation) return;
    setSync('MIC PATH VERIFIED — RELEASING…', 'on');
    stream.getTracks().forEach((t) => t.stop());        // throwaway stream
    mic.release();
    setSync('MIC PATH VERIFIED — HW SLEEPING', 'on');
    toast('MIC OK — SLEEPS TILL PTT');
    log('MIC VERIFY PASS — HARDWARE OFF', 'sys');
  } catch (e) {
    setSync('MIC BLOCKED — CHECK LOCK ICON', 'warn');
    log(`MIC DENIED — ${e instanceof Error ? e.message : String(e)}`, 'warn');
    toast('⚠ ALLOW MIC');
  }
}

/* SHARE — copy link to clipboard (no prompt); falls back gracefully */
function shareChannel(): void {
  const raw = typeof state.secret === 'string' ? state.secret : '';
  const norm = normalizeRoomSecret(raw);
  if (!isValidRoomSecret(norm)) {
    joinError('BAD KEY — CHECK LINK');
    log('BAD KEY — SHARE REFUSED — CHECK LINK', 'warn');
    return;
  }
  if (norm !== raw) set({ secret: norm });
  // A share never opts into persistence by itself: keys are written only
  // when the session persists (remember-me).
  if (sessionPersist) {
    safeSet('wlk1-ch', state.channel || '22');
    safeSet('wlk1-key', norm);
  }
  const url = buildShareLink(state.channel || '22', norm, location.origin, location.pathname);
  const done = (): void => {
    toast(`LINK COPIED — CH ${state.channel}`);
    log(`URL EXPORTED — CH ${state.channel} (+KEY)`, 'sys');
    sfx.lock();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
}
function fallbackCopy(url: string, done: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = url; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('COPY FAILED'); }
  ta.remove();
}

/* copy all logs from the hack log area to clipboard */
function copyAllLogs(): void {
  const b = $('hackLines');
  if (!b) return;
  const text = Array.from(b.children).map((row) => {
    const time = row.querySelector('.t')?.textContent?.trim() || '';
    const dir = row.querySelector('.dir')?.textContent?.trim() || '';
    const body = row.querySelector('.body')?.textContent?.trim() || '';
    return `${time} ${dir} ${body}`.trim();
  }).join('\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('LOGS COPIED')).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { toast('COPY FAILED'); }
      ta.remove();
    });
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { toast('COPY FAILED'); }
    ta.remove();
  }
}
/* ── remote audio + analysers ─────────────────────────────── */
const audioEls = new Map<number, HTMLAudioElement>();
const audioStreams = new Map<number, MediaStream>();
const storedVol = Number(safeGet('wlk1-vol') ?? 0.8);
let volLevel = Number.isFinite(storedVol) ? Math.min(1, Math.max(0, storedVol)) : 0.8;

/** Replay every remote element (autoplay-policy nudge). One toast max. */
export function replayAudio(): void {
  let failed = false;
  for (const [, a] of audioEls) {
    a.play().catch(() => {
      if (!failed) { failed = true; toast('TAP TO UNMUTE'); }
    });
  }
}

on('peers', (v: unknown) => {
  if (!(v instanceof Map)) return;
  const peers = v as Map<number, PeerInfo>;
  renderChips(peers);
  for (const [slot, p] of peers) {
    if (p.linked && p.stream) {
      const known = audioStreams.get(slot);
      let a = audioEls.get(slot);
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true; a.style.display = 'none';
        a.srcObject = p.stream;
        a.volume = volLevel;
        document.body.appendChild(a);
        audioEls.set(slot, a);
        audioStreams.set(slot, p.stream);
        a.play().catch(() => toast('TAP TO UNMUTE'));
        try { const t = analyserFor(p.stream); loop.registerRemote(slot, t.an, t.src); } catch { /* noop */ }
      } else if (known !== p.stream) {
        // Stream identity changed (renegotiation) — swap srcObject.
        a.srcObject = p.stream;
        a.volume = volLevel;
        audioStreams.set(slot, p.stream);
        try {
          loop.unregisterRemote(slot);
          const t = analyserFor(p.stream);
          loop.registerRemote(slot, t.an, t.src);
        } catch { /* noop */ }
        a.play().catch(() => { /* gesture-gated; unlockAudio replays */ });
      }
    }
    if (!p.linked && audioEls.has(slot)) {
      audioEls.get(slot)?.remove();
      audioEls.delete(slot);
      audioStreams.delete(slot);
      loop.unregisterRemote(slot);
    }
  }
  const countEl = $('lnkCount');
  if (countEl) countEl.textContent = String(linkedCount());
  syncChipsSpeaking(peers);
  updateGlow(peers);
});

/* chip speaking class + shell light-spill, driven by declared presence so
   they stay truthful even while the VAD loop sleeps (single writer here;
   the loop only adds energy while awake). */
function syncChipsSpeaking(peers: Map<number, PeerInfo>): void {
  const box = $('peers');
  if (!box) return;
  for (const child of box.children) {
    const el = child as HTMLElement;
    const slot = +(el.dataset['slot'] ?? -1);
    el.classList.toggle('speaking', peers.get(slot)?.speaking === true);
  }
}

function updateGlow(peers?: Map<number, PeerInfo>): void {
  const shell = $('shell');
  if (!(shell instanceof HTMLElement)) return;
  const map = peers ?? state.peers;
  const rx = !state.tx && [...map.values()].some((p) => p.linked && p.speaking);
  shell.classList.toggle('tx-glow', state.tx === true);
  shell.classList.toggle('rx-glow', rx);
  // Antenna lamp follows the actual link state. #batt untouched (deferred).
  $('antenna')?.classList.toggle('live', state.joined === true || state.tx === true);
}

on('tx', () => updateGlow());
on('joined', () => updateGlow());

function renderChips(peers: Map<number, PeerInfo>): void {
  const box = $('peers');
  if (!box) return;
  const wanted = [...peers.entries()].filter(([, p]) => p.linked).map(([s]) => s).sort((a, b) => a - b);
  const have = [...box.children].map((c) => +(c as HTMLElement).dataset['slot']!);
  if (JSON.stringify(wanted) === JSON.stringify(have)) return;   // no rebuild churn
  box.replaceChildren(...wanted.map((s) => {
    const c = document.createElement('div');
    c.className = 'chip'; c.dataset['slot'] = String(s);
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); label.textContent = `UNIT-${s}`;
    c.append(dot, label);
    return c;
  }));
}

function analyserFor(stream: MediaStream): { an: AnalyserNode; src: AudioNode } {
  sfx.unlock();
  const ctx = sfx.ctx;
  if (!ctx) throw new Error('AudioContext unavailable');
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 64;
  src.connect(an);
  return { an, src };
}

/* ── LCD bindings ─────────────────────────────────────────── */
on('sas', (v: unknown) => {
  const code = typeof v === 'string' ? v : null;
  const enc = document.querySelector('.enc');
  if (!enc || !code) return;
  enc.textContent = `🔒 E2E · ${code}`;
  log(`SAS ${code} — VERIFY ALOUD, MANUAL CHECK`, 'sys');
  toast(`SAS ${code} — VERIFY ALOUD, MANUAL CHECK`);
});
on('e2eeMode', (v: unknown) => {
  const m = typeof v === 'string' ? v : '';
  const enc = document.querySelector('.enc');
  if (enc && m === 'dtls-only') enc.textContent = '🔒 SRTP';
});
/* badge tells the truth per actual leg crypto state */
onCrypto((status: string) => {
  const enc = document.querySelector('.enc');
  if (!enc || state.e2eeMode === 'dtls-only') return;
  enc.textContent =
    status === 'e2ee' ? (typeof state.sas === 'string' && state.sas ? `🔒 E2E · ${state.sas}` : '🔒 E2E')
    : status === 'mixed' ? '⚠ MIXED SRTP'
    : status === 'pending' ? '🔒 E2E…'
    : status === 'ready' ? '🔒 E2E'
    : '🔒 SRTP';
});
on('change', () => {
  if (!state.tx && meshRt.peer && state.joined) {
    if (linkedCount()) setSync(`CH ${state.channel} — ${linkedCount()} UNIT${linkedCount() > 1 ? 'S' : ''}`, 'on');
    else setSync(`CH ${state.channel} — SOLO • WAITING`, 'off');
  }
});
onQuality((q: number) => {
  document.querySelectorAll('#sigbars i').forEach((b, i) => b.classList.toggle('on', i < q));
});

/* ── volume slider ────────────────────────────────────────
   Native range input: free keyboard (arrows) + screen-reader support
   on every browser. Fill var keeps the LCD-green level readable. */
function setupVolume(): void {
  const slider = $('volSlider');
  const val = $('volVal');
  if (!(slider instanceof HTMLInputElement)) return;
  const apply = (): void => {
    const n = Number(slider.value);
    volLevel = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : volLevel;
    slider.style.setProperty('--vol-fill', `${Math.round(volLevel * 100)}%`);
    if (val) val.textContent = String(Math.round(volLevel * 100));
    for (const [, a] of audioEls) a.volume = volLevel;
  };
  slider.value = String(Math.round(volLevel * 100));
  apply();
  slider.addEventListener('input', apply);
  slider.addEventListener('change', () => {
    safeSet('wlk1-vol', String(volLevel));
    toast(`VOL ${Math.round(volLevel * 100)}`);
  });
}
/* global volume nudge (slider focused → native arrows win, skip double-step) */
function nudgeVolume(delta: number): void {
  const slider = $('volSlider');
  if (!(slider instanceof HTMLInputElement) || document.activeElement === slider) return;
  slider.value = String(Math.min(100, Math.max(0, Number(slider.value) + delta)));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  safeSet('wlk1-vol', String(volLevel));
}

/* ── boot ─────────────────────────────────────────────────── */
setupKeypad();
setupVolume();
setupJoin();
setupSettings();
fit();
window.addEventListener('resize', fit, { passive: true });
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearWords(); // words never linger in a backgrounded tab
});
bootSequence(['MEM OK', `CRYPTO ${E2EE.supported() ? 'E2EE-READY' : 'SRTP'}`, 'MIC COLD']);
matrixRain();
/* Hold the shell invisible until display fonts arrive — kills the
   fallback-font swap flash on cold load. Preloads make this ~1 RTT;
   the timeout force-reveals if fonts fail (offline/system fonts). */
const docFonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
if (docFonts?.ready) {
  const show = (): void => { document.body.classList.add('fonts-ready'); };
  docFonts.ready.then(show, show);
  setTimeout(show, 1500);
} else {
  document.body.classList.add('fonts-ready');
}
log(`WLK-1 INIT — GHOSTCOM ONLINE — ${E2EE.supported() ? 'E2EE SUPPORTED' : 'SRTP ONLY ON THIS BROWSER'}`, 'sys');
route(); // join/settings first; full share links boot straight into radio

/* gestures unlock audio (autoplay policy + Safari AudioContext).
   Resumes the silent sender context, replays remote audio, and retries
   any lower-slot dials that were skipped pre-gesture.
   Idempotent — safe on every tap/key. */
function unlockAudio(): void {
  try { sfx.unlock(); } catch { /* noop */ }
  resumeSilentContext();
  try { replayAudio(); } catch { /* noop */ }
  try { mesh.retryPendingDials(); } catch { /* noop */ }
  /* resume() is async — retry once it has had a beat to go live,
     so the first tap already dials instead of the second. */
  setTimeout(() => { try { mesh.retryPendingDials(); } catch { /* noop */ } }, 350);
}
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

/* PWA service worker */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
