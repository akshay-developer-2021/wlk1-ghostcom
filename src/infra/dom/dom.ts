/* infra/dom/dom.ts — DOM helpers. All peer/system text goes through
   textContent (XSS-safe by construction). Storage helpers wrapped. */

export const $ = (id: string): HTMLElement | null => document.getElementById(id);

/** Non-null lookup for elements that must exist; throws otherwise. */
export function req(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[wlk1] missing #${id}`);
  return el;
}

/** Viewport height for mobile. */
export function fit(): void {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}

/** Copy all log lines to clipboard. */
export function copyAllLogs(): void {
  const lines = $('hackLines');
  if (!lines) return;
  const text = Array.from(lines.children).map((row) => {
    const time = row.querySelector('.t')?.textContent?.trim() || '';
    const dir = row.querySelector('.dir')?.textContent?.trim() || '';
    const body = row.querySelector('.body')?.textContent?.trim() || '';
    return `${time} ${dir} ${body}`.trim();
  }).join('\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('LOGS COPIED')).catch(fallback);
  } else fallback(text);
  function fallback(t: string) {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('LOGS COPIED'); } catch { toast('COPY FAILED'); }
    ta.remove();
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string, ms = 2400): void {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function setSync(text: string, mode = 'off'): void {
  const b = $('syncBar');
  if (!b) return;
  if (b.textContent !== text) b.textContent = text;
  b.className = `sync-bar ${mode}`;
}

export function setLed(id: string, cls = ''): void {
  const el = $(id);
  if (!el) return;
  const next = `led${cls ? ` ${cls}` : ''}`;
  if (el.className !== next) el.className = next;
}

export function setMicLed(hot: boolean): void { setLed('micLed', hot ? 'tx' : ''); }

let pktCount = 0;
export function countPkt(): void {
  pktCount++;
  const el = $('pktCount');
  if (el) el.textContent = `${pktCount} PKTS`;
}

export type LogKind = 'sys' | 'tx' | 'rx' | 'warn';

/* Traffic log — textContent only; no fabricated hex (honest telemetry).
   kind accepts any string (unknown kinds render as system lines) so this
   logger stays assignable to the audio/security LogFn surfaces. */
export function log(msg: string, kind: string = 'sys'): void {
  const b = $('hackLines');
  if (!b) return;
  const t = new Date().toTimeString().slice(0, 8);
  const k: LogKind = kind === 'tx' || kind === 'rx' || kind === 'warn' ? kind : 'sys';
  const dir = k === 'tx' ? '▲TX' : k === 'rx' ? '▼RX' : k === 'warn' ? '!!' : '··';
  const row = document.createElement('div');
  row.className = `ln ${k}`;
  const time = document.createElement('span');
  time.className = 't'; time.textContent = `[${t}]`;
  const d = document.createElement('span');
  d.className = 'dir'; d.textContent = dir;
  const body = document.createElement('span');
  body.className = 'body'; body.textContent = msg;   // untrusted-safe
  row.append(time, ' ', d, ' ', body);
  b.appendChild(row);
  b.scrollTop = b.scrollHeight;
  while (b.children.length > 40) b.firstChild?.remove();

  // Console output for Playwright capture
  const prefix = kind === 'tx' ? '▲TX' : kind === 'rx' ? '▼RX' : kind === 'warn' ? '!!' : '··';
  console.log(`[WLK1] ${new Date().toTimeString().slice(0, 8)} ${prefix} ${msg}`);
}

