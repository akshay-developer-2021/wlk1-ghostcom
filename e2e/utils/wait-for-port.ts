/**
 * Block until the signaling broker answers.
 *
 * The probe must speak the broker's own protocol: a wss broker does not
 * answer a plain-http request, and node's fetch refuses the self-signed
 * test certificate — so a secure probe must complete a TLS handshake with
 * certificate verification off, exactly what the test contexts do.
 */
import { request as httpsRequest } from 'node:https';

function probeTls(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
      res.resume();
      resolve();   // any TLS-complete HTTP answer means the server is listening
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function waitForPort(port: number, timeoutMs = 10000, secure = false): Promise<void> {
  const url = `${secure ? 'https' : 'http'}://localhost:${port}/peerjs`;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      if (secure) {
        await probeTls(url);
        return;
      }
      const response = await fetch(url);
      // any HTTP answer means the server is listening (404 included)
      if (response.ok || response.status === 404) return;
    } catch {
      /* not up yet (or TLS still negotiating) */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`);
}
