/**
 * Single source of truth for where the e2e suite points.
 *
 * Defaults run everything on localhost: the built app behind vite preview and
 * a local PeerJS broker spawned by globalSetup. Set E2E_BASE_URL to run the
 * exact same journeys against a deployed origin (e.g. surge.sh) — which also
 * makes the service worker live, since it only registers over https.
 *
 *   E2E_BASE_URL=https://app.surge.sh npm run test:e2e
 *
 * A deployed run serves the app from the deployment but keeps the broker
 * under our control: Chrome blocks ws:// from an https page, and the public
 * PeerJS Cloud returns HTTP 429, so the broker must be local AND speak TLS.
 */

const env = process.env;

export const BASE_URL = (env['E2E_BASE_URL'] ?? 'http://localhost:4173').replace(/\/+$/, '');

export const IS_REMOTE = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);

/** Precache the built app behind `vite preview` only when we own the origin. */
export const USE_LOCAL_SERVER = !IS_REMOTE;

/**
 * Against a deployed origin we still need a broker we control: the public
 * PeerJS Cloud answers HTTP 429 (rate-limited) to a plain browser, so a real
 * visitor gets no radio at all. Browsers also block ws:// from an https page,
 * so that broker must speak wss — hence a self-signed local one.
 */
export const TLS_BROKER = IS_REMOTE || env['E2E_TLS_BROKER'] === 'true';

export const BROKER = {
  host: env['E2E_BROKER_HOST'] ?? 'localhost',
  port: Number(env['E2E_BROKER_PORT'] ?? 9000),
  path: env['E2E_BROKER_PATH'] ?? '/peerjs',
  secure: TLS_BROKER || env['E2E_BROKER_SECURE'] === 'true',
  /** Skip the local spawn and use a broker that is already running. */
  external: env['E2E_BROKER_EXTERNAL'] === 'true',
};

/** window.WLK1_CONFIG injected before app code runs. */
export const BROKER_CONFIG = {
  signalingHost: BROKER.host,
  signalingPort: BROKER.port,
  signalingPath: BROKER.path,
  signalingSecure: BROKER.secure,
};

/**
 * Inject a broker override into the page? Only when we run our own broker.
 * Against a deployed https origin a browser BLOCKS ws://localhost (mixed
 * content), so the run must use the app's own default broker — which is
 * exactly what a real user gets.
 */
export const INJECT_BROKER = !IS_REMOTE || env['E2E_INJECT_BROKER'] === 'true';

/** How many 1:1 sessions the batch spec runs. */
export const BATCH_SIZE = Math.max(1, Number(env['E2E_BATCH'] ?? 3));

export const ROOM_CHANNEL = env['E2E_CHANNEL'] ?? '22';