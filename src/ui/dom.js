/* ui/dom.js — DOM helpers. All peer/system text goes through
   textContent (XSS-safe by construction, unlike the PoC's innerHTML). */

export const $ = (id) => document.getElementById(id);

let toastTimer = null;
export function toast(msg, ms = 2400) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function setSync(text, mode = 'off') {
  const b = $('syncBar');
  if (!b) return;
  if (b.textContent !== text) b.textContent = text;
  b.className = `sync-bar ${mode}`;
}

export function setLed(id, cls = '') {
  const el = $(id);
  if (!el) return;
  const next = `led${cls ? ` ${cls}` : ''}`;
  if (el.className !== next) el.className = next;
}

export function setMicLed(hot) { setLed('micLed', hot ? 'tx' : ''); }

let pktCount = 0;
export function countPkt() {
  pktCount++;
  const el = $('pktCount');
  if (el) el.textContent = `${pktCount} PKTS`;
}
export const pktTotal = () => pktCount;

/* Traffic log — textContent only; no fabricated hex (honest telemetry). */
export function log(msg, kind = 'sys') {
  const b = $('hackLines');
  if (!b) return;
  const t = new Date().toTimeString().slice(0, 8);
  const dir = kind === 'tx' ? '▲TX' : kind === 'rx' ? '▼RX' : kind === 'warn' ? '!!' : '··';
  const row = document.createElement('div');
  row.className = `ln ${kind}`;
  const time = document.createElement('span');
  time.className = 't'; time.textContent = `[${t}]`;
  const d = document.createElement('span');
  d.className = 'dir'; d.textContent = dir;
  const body = document.createElement('span');
  body.className = 'body'; body.textContent = msg;   // untrusted-safe
  row.append(time, ' ', d, body);
  b.appendChild(row);
  b.scrollTop = b.scrollHeight;
  while (b.children.length > 40) b.removeChild(b.firstChild);
}
