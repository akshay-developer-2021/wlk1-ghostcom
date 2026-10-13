/* ui/dom.ts — DOM helpers. All peer/system text goes through
   textContent (XSS-safe by construction, unlike the PoC's innerHTML).
   Storage helpers are safe by construction: every localStorage /
   sessionStorage access is wrapped — Firefox private mode throws. */

export const $ = (id: string): HTMLElement | null => document.getElementById(id);

/** Non-null lookup for elements that must exist; throws otherwise. */
export function req(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[wlk1] missing #${id}`);
  return el;
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
export const pktTotal = (): number => pktCount;

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
}

/* ── safe storage (Firefox private mode throws on access) ─── */
export function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: persistence skipped */ }
}
export function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* noop */ }
}
export function safeSessGet(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
export function safeSessSet(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch { /* noop */ }
}
export function safeSessRemove(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* noop */ }
}
