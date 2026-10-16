import { test, expect, chromium, firefox, webkit, type Browser, type Page } from '@playwright/test';
import { BATCH_SIZE, BROKER_CONFIG, BASE_URL, TLS_BROKER, INJECT_BROKER } from './utils/env';
import { FAKE_MIC_SCRIPT, needsFakeMicStub, grantMicPermissions } from './utils/media';
import { applyBrokerConfig } from './utils/room';
import { joinRoom } from './utils/room';
import { toneRoundTrip, leaveToJoin } from './utils/mesh-helpers';
import { assertPeerCount, assertPeerChips, assertScreenVisible, assertSyncBar } from './utils/assertions';

/**
 * 1:1 batch simulator.
 *
 * Each session launches TWO SEPARATE BROWSER PROCESSES — not two contexts in
 * one — so the two sides get independent AudioContexts, service workers and
 * storage, the way two real users do. A session proves the whole short-lived
 * radio path: join, linked, tone crosses the mesh, one leaves, survivor is
 * honest. Repeated N times to shake out races and state that only leaks on
 * the second or third session.
 *
 * E2E_BATCH=25 npm run test:e2e:batch
 */

const LAUNCH_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  /* a deployed https origin is blocked from wss://localhost by Chrome's
     local-network policy; the remote recipe injects a local TLS broker */
  '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults',
];

async function launchUser(label: string, browserName = 'chromium'): Promise<{ browser: Browser; page: Page }> {
  const type = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium;
  const browser = await type.launch(browserName === 'chromium' ? { args: LAUNCH_ARGS } : {});
  /* An injected TLS broker is self-signed (test artifact) — the context
     must accept it or every wss handshake dies. */
  const context = await browser.newContext({ ignoreHTTPSErrors: TLS_BROKER && INJECT_BROKER });
  await grantMicPermissions(context, browserName);
  if (needsFakeMicStub(browserName)) await context.addInitScript(FAKE_MIC_SCRIPT);
  const page = await context.newPage();
  await applyBrokerConfig(page);
  page.on('pageerror', (err) => { throw new Error(`[${label}] uncaught page error: ${err.message}`); });
  return { browser, page };
}

test.describe.configure({ retries: 0, timeout: 600_000 });

test(`1x1 batch: ${BATCH_SIZE} independent two-user sessions against ${BASE_URL}`, async ({}, testInfo) => {
  const browserName = testInfo.project.name;
  const measureAudio = browserName !== 'webkit';   // WebKit cannot decode its own recording
  const results: string[] = [];

  for (let i = 1; i <= BATCH_SIZE; i++) {
    const started = Date.now();
    const alice = await launchUser(`alice#${i}`, browserName);
    const bob = await launchUser(`bob#${i}`, browserName);

    try {
      await joinRoom(alice.page, bob.page);

      await assertPeerCount(alice.page, 1);
      await assertPeerCount(bob.page, 1);
      await assertPeerChips(alice.page, 1);
      await assertPeerChips(bob.page, 1);

      /* a real tone must cross the mesh, not just the indicators light up */
      if (measureAudio) await toneRoundTrip(alice.page, bob.page, 1000, 2000, `batch${i}-a2b`);

      /* leaving must leave the survivor live and honest */
      await leaveToJoin(alice.page);
      await assertScreenVisible(bob.page, 'radio');
      await assertPeerCount(bob.page, 0);
      await assertPeerChips(bob.page, 0);
      await assertSyncBar(bob.page, 'ON CHANNEL — NO OTHER UNITS');

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      results.push(`session ${i}: OK (${secs}s)`);
      console.log(`[batch] session ${i}/${BATCH_SIZE} OK in ${secs}s`);
    } finally {
      await Promise.allSettled([alice.browser.close(), bob.browser.close()]);
    }
  }

  console.log(`\n[batch] ${results.length}/${BATCH_SIZE} sessions passed`);
  expect(results).toHaveLength(BATCH_SIZE);
});

/**
 * Cross-engine session: the pair the real world actually produces.
 *
 * Same-engine runs cannot catch the class of bug that only appears when
 * the two ends are different engines — the DataChannel deadlock that
 * looped Brave<->Firefox forever was invisible to every same-engine lane.
 * These pair chromium with the project's other engines and assert the
 * whole radio path: join, indicators, tone across the mesh, honest leave.
 *
 * E2E_CROSS_PAIRS=chromium,webkit,firefox (default: the two that ship).
 */
const CROSS_PAIRS = (process.env['E2E_CROSS_PAIRS'] ?? 'chromium:webkit')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

test.describe.configure({ retries: 0, timeout: 600_000 });

for (const pair of CROSS_PAIRS) {
  const [left, right] = pair.split(':');
  if (!left || !right) continue;

  test(`cross-engine: ${left} <-> ${right}`, async () => {
    /* neither side may be WebKit when we must measure the tone */
    const measureAudio = left !== 'webkit' && right !== 'webkit';
    const alice = await launchUser(`alice:${left}`, left);
    const bob = await launchUser(`bob:${right}`, right);
    try {
      await joinRoom(alice.page, bob.page);
      await assertPeerCount(alice.page, 1);
      await assertPeerCount(bob.page, 1);
      await assertPeerChips(alice.page, 1);
      await assertPeerChips(bob.page, 1);

      if (measureAudio) {
        await toneRoundTrip(alice.page, bob.page, 1000, 2000, `x-${left}-${right}-a2b`);
        await toneRoundTrip(bob.page, alice.page, 1000, 2000, `x-${left}-${right}-b2a`);
      }

      await leaveToJoin(alice.page);
      await assertScreenVisible(bob.page, 'radio');
      await assertPeerCount(bob.page, 0);
      await assertSyncBar(bob.page, 'ON CHANNEL — NO OTHER UNITS');
    } finally {
      await Promise.allSettled([alice.browser.close(), bob.browser.close()]);
    }
  });
}
