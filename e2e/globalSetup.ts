import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { waitForPort } from './utils/wait-for-port';
import { BROKER, BASE_URL, TLS_BROKER, INJECT_BROKER } from './utils/env';

const PID_FILE = join('test-results', '.broker.pid');
const TLS_CERT = join('test-results', 'tls', 'broker.crt');
const TLS_KEY = join('test-results', 'tls', 'broker.key');

/** The self-signed cert is a test artifact — regenerate it when missing. */
function ensureTlsCert(): void {
  if (existsSync(TLS_CERT) && existsSync(TLS_KEY)) return;
  mkdirSync(dirname(TLS_CERT), { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', TLS_KEY, '-out', TLS_CERT, '-days', '365',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  console.log('[globalSetup] generated a self-signed broker certificate');
}

/** A broker left behind by a hard-killed run would silently serve the tests. */
function killStaleBroker(): void {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (Number.isFinite(pid)) {
    try { process.kill(pid, 'SIGTERM'); console.log(`[globalSetup] killed stale broker ${pid}`); } catch { /* gone */ }
  }
}

export default async function globalSetup(): Promise<void> {
  console.log(`[globalSetup] app=${BASE_URL} broker=${BROKER.host}:${BROKER.port}${BROKER.path}`);

  if (BROKER.external) {
    console.log('[globalSetup] E2E_BROKER_EXTERNAL=true — not spawning a broker.');
    return;
  }

  killStaleBroker();
  if (TLS_BROKER && INJECT_BROKER) ensureTlsCert();
  console.log(`[globalSetup] starting local PeerJS broker on port ${BROKER.port}…`);

  /* Local devDependency bin — no network fetch, no version drift. */
  const bin = join('node_modules', 'peer', 'dist', 'bin', 'peerjs.js');
  const args = [bin, '--port', String(BROKER.port), '--path', BROKER.path, '--allow_discovery'];
  if (TLS_BROKER) args.push('--sslcert', TLS_CERT, '--sslkey', TLS_KEY);
  const broker: ChildProcess = spawn(
    process.execPath,
    args,
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } },
  );

  broker.stdout?.on('data', (d: Buffer) => console.log(`[PeerJS] ${d.toString().trim()}`));
  broker.stderr?.on('data', (d: Buffer) => console.error(`[PeerJS] ${d.toString().trim()}`));
  broker.on('error', (err) => console.error('[PeerJS] Failed to start:', err));

  mkdirSync('test-results', { recursive: true });
  if (broker.pid) writeFileSync(PID_FILE, String(broker.pid));

  try {
    await waitForPort(BROKER.port, 15000, BROKER.secure);
    console.log('[globalSetup] PeerJS broker ready.');
  } catch (err) {
    broker.kill();
    throw err;
  }
}