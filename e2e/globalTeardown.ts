import { readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

const PID_FILE = join('test-results', '.broker.pid');

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  rmSync(PID_FILE, { force: true });
  if (!Number.isFinite(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[globalTeardown] PeerJS broker (pid ${pid}) stopped.`);
  } catch {
    /* already gone */
  }
}
