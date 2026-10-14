/* src/config.ts — deployment knobs.
   Precedence (lowest → highest):
   1. built-in defaults below
   2. persisted JSON in localStorage (safe reads — private mode throws):
      · "wlk1-broker" = {"host": "broker.example.com", "secure": true}
      · "wlk1-turn"   = [ {urls, username, credential, credentialType}, … ]
      (written by the Settings screen)
   3. window.WLK1_CONFIG deployment overrides.
   Changing the broker/TURN takes effect on next load (Settings reloads). */

export interface SignalingConfig {
  host?: string | undefined;
  secure: boolean;
  port?: number | undefined;
  path?: string | undefined;
  key?: string | undefined;
}

export interface ReconnectConfig {
  maxTries: number;
  baseMs: number;
  maxMs: number;
}

/** ICE server with the Safari-strict TURN fields the DOM lib omits. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: 'password' | 'oauth';
}

export interface AppConfig {
  signaling: SignalingConfig;
  iceServers: IceServer[];
  maxSlots: number;
  slotProbeTimeoutMs: number;
  warmWindowMs: number;
  watchdogMs: number;
  statsPollMs: number;
  maxTxMs: number;            // safety: TX auto-cutoff after 5 min
  reconnect: ReconnectConfig;
}

/** Deployment override surface: window.WLK1_CONFIG = {signalingHost, iceServers} */
export interface WindowWlk1Config {
  signalingHost?: string;
  signalingSecure?: boolean;
  signalingPort?: number;
  signalingPath?: string;
  signalingKey?: string;
  iceServers?: IceServer[];
}

declare global {
  interface Window {
    WLK1_CONFIG?: WindowWlk1Config;
  }
}

export const BROKER_STORE_KEY = 'wlk1-broker';
export const TURN_STORE_KEY = 'wlk1-turn';

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null; // private mode / corrupt JSON: fall back to defaults
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asIceServers(v: unknown): IceServer[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: IceServer[] = [];
  for (const e of v) {
    if (!isRecord(e)) return null;
    const urls = e['urls'];
    if (typeof urls !== 'string' && !Array.isArray(urls)) return null;
    const srv: IceServer = { urls: urls as string | string[] };
    if (typeof e['username'] === 'string') srv.username = e['username'];
    if (typeof e['credential'] === 'string') srv.credential = e['credential'];
    if (e['credentialType'] === 'password' || e['credentialType'] === 'oauth') {
      srv.credentialType = e['credentialType'];
    }
    out.push(srv);
  }
  return out;
}

const DEFAULT_ICE: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Public OpenRelay is a best-effort fallback. For production run your
  // own coturn and use short-lived HMAC credentials (see README).
  // turns: + credentialType are explicit for Safari, which prefers
  // TLS TURN and strict RTCConfiguration parsing (Firefox/Safari).
  {
    urls: [
      'turn:standard.openrelay.metered.ca:80',
      'turn:standard.openrelay.metered.ca:443',
      'turn:standard.openrelay.metered.ca:443?transport=tcp',
      'turns:standard.openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
    credentialType: 'password',
  },
];

function buildConfig(): AppConfig {
  const cfg: AppConfig = {
    signaling: { host: undefined, secure: true },
    iceServers: DEFAULT_ICE,
    maxSlots: 8,
    slotProbeTimeoutMs: 4000,
    warmWindowMs: 45_000,
    watchdogMs: 15_000,
    statsPollMs: 15_000,
    maxTxMs: 5 * 60_000,
    reconnect: { maxTries: 5, baseMs: 500, maxMs: 8000 },
  };

  // Layer 2 — persisted Settings overrides (safe).
  const broker = readJson(BROKER_STORE_KEY);
  if (isRecord(broker)) {
    if (typeof broker['host'] === 'string' && broker['host'].trim()) {
      cfg.signaling = { ...cfg.signaling, host: broker['host'].trim() };
    }
    if (typeof broker['secure'] === 'boolean') {
      cfg.signaling = { ...cfg.signaling, secure: broker['secure'] };
    }
    if (typeof broker['port'] === 'number' && Number.isFinite(broker['port'])) {
      cfg.signaling = { ...cfg.signaling, port: broker['port'] };
    }
    if (typeof broker['path'] === 'string' && broker['path'].trim()) {
      cfg.signaling = { ...cfg.signaling, path: broker['path'].trim() };
    }
    if (typeof broker['key'] === 'string' && broker['key'].trim()) {
      cfg.signaling = { ...cfg.signaling, key: broker['key'].trim() };
    }
  }
  const turn = asIceServers(readJson(TURN_STORE_KEY));
  if (turn) cfg.iceServers = turn;

  // Layer 3 — deployment overrides win over everything persisted.
  try {
    const w = typeof window !== 'undefined' ? window.WLK1_CONFIG : undefined;
    if (w) {
      if (typeof w.signalingHost === 'string' && w.signalingHost.trim()) {
        cfg.signaling = { ...cfg.signaling, host: w.signalingHost.trim() };
      }
      if (typeof w.signalingSecure === 'boolean') {
        cfg.signaling = { ...cfg.signaling, secure: w.signalingSecure };
      }
      if (typeof w.signalingPort === 'number' && Number.isFinite(w.signalingPort)) {
        cfg.signaling = { ...cfg.signaling, port: w.signalingPort };
      }
      if (typeof w.signalingPath === 'string' && w.signalingPath.trim()) {
        cfg.signaling = { ...cfg.signaling, path: w.signalingPath.trim() };
      }
      if (typeof w.signalingKey === 'string' && w.signalingKey.trim()) {
        cfg.signaling = { ...cfg.signaling, key: w.signalingKey.trim() };
      }
      const ice = asIceServers(w.iceServers);
      if (ice) cfg.iceServers = ice;
    }
  } catch {
    /* noop — window access never throws in practice; kept symmetric */
  }
  return cfg;
}

export const CONFIG: AppConfig = buildConfig();
