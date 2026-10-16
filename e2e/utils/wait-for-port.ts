/**
 * Block until the signaling broker answers.
 *
 * The probe must speak the broker's own protocol: a wss broker rejects a
 * plain-http request outright, so a http probe would time out against a
 * perfectly healthy TLS broker.
 */
export async function waitForPort(port: number, timeoutMs = 10000, secure = false): Promise<void> {
  const url = `${secure ? 'https' : 'http'}://localhost:${port}/peerjs`;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, secure ? { /* self-signed test cert */ } : {});
      // any HTTP answer means the server is listening (404 included)
      if (response.ok || response.status === 404) return;
    } catch {
      /* not up yet (or TLS still negotiating) */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`);
}