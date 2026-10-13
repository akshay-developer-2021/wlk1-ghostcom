/* ═══════════════════════════════════════════════════════════════
   WLK-1 GHOSTCOM — production main.
   Wire-up only; all logic lives in domain modules.
   ═══════════════════════════════════════════════════════════════ */

import '@fontsource/vt323';
import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import './styles/main.css';

import { CONFIG } from './config.js';
import { generateRoomSecret, isValidRoomSecret, parseChannelHash, buildShareLink } from './core/crypto.js';
import { E2EE, deriveRawGroupKey } from './security/e2ee.js';
import { set, state, on, linkedCount } from './core/state.js';
import { PowerManager } from './core/battery.js';
import { MicManager } from './audio/mic.js';
import { Sfx, HAPTIC } from './audio/sfx.js';
import { Mesh, onQuality, onCrypto } from './webrtc/mesh.js';
import { $, log, toast, setSync, countPkt } from './ui/dom.js';
import { createPTT } from './ui/ptt.js';
import { createLoop } from './ui/loop.js';
import { bootSequence, matrixRain, showHintOnce, fit } from './ui/boot.js';

/* ── instantiate the machine room ─────────────────────────── */
const sfx = new Sfx({ log });
const mic = new MicManager({ warmWindowMs: CONFIG.warmWindowMs, log });
const power = new PowerManager({ log });
const loop = createLoop({ sfx, onSuspend: () => sfx.suspend() });

/* E2EE is initialized once the room secret is known (see rekeyE2EE). */
let e2ee = null;
set({ e2eeMode: E2EE.supported() ? 'e2ee-ready' : 'dtls-only' });

const mesh = new Mesh({ sfx, mic, e2ee, log, config: CONFIG });
const ptt = createPTT({
  mesh, mic, sfx, power, config: CONFIG,
  onAnalyser: (s) => loop.registerTx(analyserFor(s)),
});

power.init();

/* ── session: hash link wins; auto-join otherwise ─────────── */
async function initSession() {
  const fromHash = parseChannelHash(location.hash);
  if (fromHash?.channel) {
    set({
      channel: fromHash.channel,
      secret: isValidRoomSecret(fromHash.secret || '') ? fromHash.secret : generateRoomSecret(),
    });
    digitBuf = fromHash.channel.split('');
    updateDisplay();
    log(`CH ${fromHash.channel} FROM LINK`, 'sys');
    toast(`CH ${fromHash.channel} FROM LINK — JOINED`);
    await rekeyE2EE();                       // keys ready BEFORE any leg dials
    const r = await mesh.join(fromHash.channel);
    if (r?.ok) mesh.startQualityPolling();
    return;
  }
  const saved = localStorage.getItem('wlk1-ch');
  const savedSecret = localStorage.getItem('wlk1-key');
  const channel = saved || '22';
  set({ channel, secret: isValidRoomSecret(savedSecret || '') ? savedSecret : generateRoomSecret() });
  localStorage.setItem('wlk1-ch', channel);
  localStorage.setItem('wlk1-key', state.secret);
  digitBuf = channel.split('');
  updateDisplay();
  await rekeyE2EE();                         // no race: keys first, then legs
  const r = await mesh.join(channel);        // JOIN BY DEFAULT — radio is live
  if (r?.ok) mesh.startQualityPolling();
}

async function rekeyE2EE() {
  if (!state.secret) return;
  if (!E2EE.supported()) { set({ e2eeMode: 'dtls-only' }); return; }
  try {
    if (e2ee) e2ee.destroy();
    const raw = await deriveRawGroupKey(crypto.subtle, state.secret);
    e2ee = new E2EE(raw, log);
    mesh.e2ee = e2ee;
    set({ e2eeMode: 'e2ee' });
    log('E2EE LAYER ACTIVE — AES-GCM FRAME CRYPTO', 'sys');
  } catch (err) {
    set({ e2eeMode: 'dtls-only' });
    log(`E2EE UNAVAILABLE — ${err.message} — SRTP ONLY`, 'warn');
  }
}


/* ── keypad: rolling dial, always responsive ──────────────── */
let digitBuf = [];
function updateDisplay() {
  const entering = digitBuf.length === 1;
  const ch = digitBuf.length ? digitBuf.join('') : (state.channel || '--');
  $('chan').textContent = `CH ${ch}${entering ? '_' : ''}`;
  $('freq').textContent = `152.${String(ch).padStart(3, '0')}`;
  $('lcd').classList.toggle('entering', entering);
}

async function enterDigit(n) {
  sfx.key();
  sfx.haptic(HAPTIC.key);
  if (digitBuf.length >= 2) digitBuf = digitBuf.slice(1);   // ROLLING dial
  digitBuf.push(String(n));
  updateDisplay();
  if (digitBuf.length === 2) await dial(digitBuf.join(''));
}

async function dial(channel) {
  if (mesh.peer && state.channel === channel) return;
  const secret = state.secret || generateRoomSecret();
  set({ channel, secret });
  await rekeyE2EE();                         // keys ready BEFORE any leg dials
  localStorage.setItem('wlk1-ch', channel);
  localStorage.setItem('wlk1-key', secret);
  const r = await mesh.join(channel);
  if (r?.ok) { mesh.startQualityPolling(); countPkt(); }
  else if (r?.reason === 'full') toast('CHANNEL FULL — ALL SLOTS TAKEN');
}

function setupKeypad() {
  document.querySelectorAll('.key[data-digit]').forEach((k) =>
    k.addEventListener('click', () => enterDigit(+k.dataset.digit)));
  $('keyDel').addEventListener('click', () => { digitBuf.pop(); sfx.key(); updateDisplay(); });
  $('keyMic').addEventListener('click', micTest);
  $('keyShare').addEventListener('click', shareChannel);

  /* physical keyboard entry */
  window.addEventListener('keydown', (e) => {
    if (/^[0-9]$/.test(e.key) && !e.repeat && document.activeElement?.tagName !== 'INPUT') enterDigit(+e.key);
    if (e.key === 'Backspace') { digitBuf.pop(); updateDisplay(); }
  });
}

/* MIC key = verify hardware path, then HARD RELEASE (PoC leak fix) */
async function micTest() {
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
    log(`MIC DENIED — ${e.message}`, 'warn');
    toast('⚠ ALLOW MIC');
  }
}

/* SHARE — copy link to clipboard (no prompt); falls back gracefully */
function shareChannel() {
  const secret = state.secret || generateRoomSecret();
  set({ secret });
  localStorage.setItem('wlk1-key', secret);
  const url = buildShareLink(state.channel || '22', secret, location.origin, location.pathname);
  const done = () => {
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
function fallbackCopy(url, done) {
  const ta = document.createElement('textarea');
  ta.value = url; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('COPY FAILED'); }
  ta.remove();
}

/* copy all logs from the hack log area to clipboard */
function copyAllLogs() {
  const b = $('hackLines');
  if (!b) return;
  const text = Array.from(b.children).map((row) => {
    const time = row.querySelector('.t')?.textContent.trim() || '';
    const dir = row.querySelector('.dir')?.textContent.trim() || '';
    const body = row.querySelector('.body')?.textContent.trim() || '';
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
$('copyLogsBtn')?.addEventListener('click', copyAllLogs);

/* ── remote audio + analysers ─────────────────────────────── */
const audioEls = new Map();
let volLevel = +(localStorage.getItem('wlk1-vol') || 0.8);

on('peers', (peers) => {
  renderChips(peers);
  for (const [slot, p] of peers) {
    if (p.linked && p.stream && !audioEls.has(slot)) {
      const a = document.createElement('audio');
      a.autoplay = true; a.style.display = 'none';
      a.srcObject = p.stream;
      a.volume = volLevel;
      document.body.appendChild(a);
      audioEls.set(slot, a);
      a.play().catch(() => toast('TAP TO UNMUTE'));
      try { loop.registerRemote(slot, analyserFor(p.stream)); } catch { /* noop */ }
    }
    if (!p.linked && audioEls.has(slot)) {
      audioEls.get(slot).remove();
      audioEls.delete(slot);
      loop.unregisterRemote(slot);
    }
  }
  $('lnkCount').textContent = linkedCount();
});

function renderChips(peers) {
  const box = $('peers');
  const wanted = [...peers.entries()].filter(([, p]) => p.linked).map(([s]) => s).sort((a, b) => a - b);
  const have = [...box.children].map((c) => +c.dataset.slot);
  if (JSON.stringify(wanted) === JSON.stringify(have)) return;   // no rebuild churn
  box.replaceChildren(...wanted.map((s) => {
    const c = document.createElement('div');
    c.className = 'chip'; c.dataset.slot = s;
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); label.textContent = `UNIT-${s}`;
    c.append(dot, label);
    return c;
  }));
}

function analyserFor(stream) {
  sfx.unlock();
  const src = sfx.ctx.createMediaStreamSource(stream);
  const an = sfx.ctx.createAnalyser();
  an.fftSize = 64;
  src.connect(an);
  return an;
}

/* ── LCD bindings ─────────────────────────────────────────── */
on('sas', (code) => {
  const enc = document.querySelector('.enc');
  if (!enc || !code) return;
  enc.textContent = `🔒 E2E · ${code}`;
  log(`CRYPTO SYNC — SAS ${code} — COMPARE WITH TEAM`, 'sys');
  toast(`SAS ${code} — VERIFY WITH TEAM`);
});
on('e2eeMode', (m) => {
  const enc = document.querySelector('.enc');
  if (enc && m === 'dtls-only') enc.textContent = '🔒 SRTP';
});
/* badge tells the truth per actual leg crypto state */
onCrypto((status) => {
  const enc = document.querySelector('.enc');
  if (!enc || state.e2eeMode === 'dtls-only') return;
  enc.textContent =
    status === 'e2ee' ? (state.sas ? `🔒 E2E · ${state.sas}` : '🔒 E2E')
    : status === 'mixed' ? '⚠ MIXED SRTP'
    : status === 'pending' ? '🔒 E2E…'
    : status === 'ready' ? '🔒 E2E'
    : '🔒 SRTP';
});
on('change', () => {
  if (!state.tx && mesh.peer && state.joined) {
    if (linkedCount()) setSync(`CH ${state.channel} — ${linkedCount()} UNIT${linkedCount() > 1 ? 'S' : ''}`, 'on');
    else setSync(`CH ${state.channel} — SOLO • WAITING`, 'off');
  }
});
onQuality((q) => {
  document.querySelectorAll('#sigbars i').forEach((b, i) => b.classList.toggle('on', i < q));
});

/* ── volume knob ──────────────────────────────────────────── */
function setupKnob() {
  const knob = $('volKnob');
  let drag = false, a0 = 0, v0 = volLevel;
  const ang = (e) => {
    const r = knob.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  knob.addEventListener('pointerdown', (e) => { drag = true; a0 = ang(e); v0 = volLevel; knob.setPointerCapture(e.pointerId); });
  knob.addEventListener('pointermove', (e) => {
    if (!drag) return;
    let d = ang(e) - a0; if (d > 180) d -= 360; if (d < -180) d += 360;
    volLevel = Math.min(1, Math.max(0, v0 + d / 270));
    knob.style.transform = `rotate(${volLevel * 270 - 135}deg)`;
    knob.setAttribute('aria-valuenow', Math.round(volLevel * 100));
    for (const [, a] of audioEls) a.volume = volLevel;
  });
  ['pointerup', 'pointercancel'].forEach((ev) => knob.addEventListener(ev, () => {
    drag = false; localStorage.setItem('wlk1-vol', String(volLevel));
  }));
  knob.style.transform = `rotate(${volLevel * 270 - 135}deg)`;
}

/* ── boot ─────────────────────────────────────────────────── */
initSession();
setupKeypad();
setupKnob();
fit();
addEventListener('resize', fit, { passive: true });
bootSequence(['MEM OK', `CRYPTO ${E2EE.supported() ? 'E2EE-READY' : 'SRTP'}`, 'MIC COLD']);
matrixRain();
showHintOnce();
log(`WLK-1 INIT — GHOSTCOM ONLINE — ${E2EE.supported() ? 'E2EE SUPPORTED' : 'SRTP ONLY ON THIS BROWSER'}`, 'sys');

/* first gesture unlocks audio (browser autoplay policy) */
addEventListener('pointerdown', () => sfx.unlock(), { once: true, capture: true });

/* PWA service worker */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
