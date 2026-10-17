import { test, expect, chromium, firefox, webkit, type Browser, type Page } from '@playwright/test';
import { BATCH_SIZE, BROKER_CONFIG, BASE_URL, TLS_BROKER, INJECT_BROKER } from './utils/env';
import { FAKE_MIC_SCRIPT, FIREFOX_USER_PREFS, needsFakeMicStub, grantMicPermissions } from './utils/media';
import { applyBrokerConfig } from './utils/room';
import { joinRoom, joinRoomAll } from './utils/room';
import { toneRoundTrip, leaveToJoin, assertEncryptedWire } from './utils/mesh-helpers';
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
  /* args must be explicit: inside a worker a manual launch() inherits the
     running project's launchOptions, so webkit/firefox silently got Chrome's
     flags. macOS ignores them, the Linux WebKit build dies on the first one
     ("Cannot parse arguments: Unknown option --use-fake-device-for-media-stream"). */
  /* A manual launch inherits the project's ARGS (which is how webkit used to
     die on Chrome flags) but not its firefoxUserPrefs — so a hand-launched
     Firefox ran with stock privacy defaults: Web Audio blocked and loopback
     candidates withheld, hence a leg that never formed. */
  const browser = await type.launch({
    args: browserName === 'chromium' ? LAUNCH_ARGS : [],
    ...(browserName === 'firefox' ? { firefoxUserPrefs: FIREFOX_USER_PREFS } : {}),
  });
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
 * Off unless E2E_CROSS_PAIRS is set: each session launches two whole
 * browsers on top of the one Playwright already runs, and a runner with
 * ~4GB will OOM ("Target page, context or browser has been closed").
 * The cross-engine CI job runs this file alone for exactly that reason.
 *   E2E_CROSS_PAIRS=chromium,webkit npm run test:e2e
 */
const CROSS_PAIRS = (process.env['E2E_CROSS_PAIRS'] ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

test.describe.configure({ retries: 0, timeout: 600_000 });

for (const pair of CROSS_PAIRS) {
  const [left, right] = pair.split(':');
  if (!left || !right) continue;

  test(`cross-engine: ${left} <-> ${right}`, async () => {
    const alice = await launchUser(`alice:${left}`, left);
    const bob = await launchUser(`bob:${right}`, right);
    try {
      await joinRoom(alice.page, bob.page);
      await assertPeerCount(alice.page, 1);
      await assertPeerCount(bob.page, 1);
      await assertPeerChips(alice.page, 1);
      await assertPeerChips(bob.page, 1);

      /* Checked while the only thing on the wire is the silent carrier: both
         ends must be transforming real frames, not shipping cleartext. WebKit
         cannot decode its own recording, so this is also the only check the
         WebKit-receives direction gets. */
      console.log(`wire ${left}:`, JSON.stringify(await assertEncryptedWire(alice.page, left)));
      console.log(`wire ${right}:`, JSON.stringify(await assertEncryptedWire(bob.page, right)));

      /* The tone is recorded on the RECEIVING side, and WebKit cannot decode
         its own MediaRecorder output — so a direction is measurable unless
         the receiver is WebKit, not unless either side is. */
      if (right !== 'webkit') {
        await toneRoundTrip(alice.page, bob.page, 1000, 2000, `x-${left}-${right}-a2b`);
      }
      if (left !== 'webkit') {
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

/**
 * The three-engine room.
 *
 * A pair proves one leg between two engines. Only a triple proves the mesh:
 * three units that all claimed slots and must therefore all be linked to
 * BOTH others, six legs transforming real frames in both directions, and a
 * departure that has to leave the two survivors each honest about LNK 1 —
 * the teardown path where a departing peer must not take the other legs down
 * with it. Three real browsers on one machine, which is also the heaviest
 * thing in the suite.
 *
 * Opt-in like the pairs, for the same reason plus memory:
 *   E2E_CROSS_TRIPLE=chromium:webkit:firefox npm run test:e2e:triple
 */
const TRIPLE = (process.env['E2E_CROSS_TRIPLE'] ?? '')
  .split(':')
  .map((t) => t.trim())
  .filter(Boolean);

if (TRIPLE.length >= 3) {
  test(`cross-engine triple: ${TRIPLE.join(' + ')}`, async () => {
    const crew: { engine: string; browser: Browser; page: Page }[] = [];
    for (const [i, engine] of TRIPLE.entries()) {
      const u = await launchUser(`${engine}-${i}`, engine);
      crew.push({ engine, ...u });
    }
    const users = crew;
    try {
      await joinRoomAll(users.map((u) => u.page));

      /* Full mesh: every unit linked to every other unit, so each side reads
         two remote chips — not just "something connected". */
      for (const u of users) {
        await assertPeerCount(u.page, TRIPLE.length - 1);
        await assertPeerChips(u.page, TRIPLE.length - 1);
        /* Per-page counters cover all six legs: outbound to two peers,
           inbound from two. */
        console.log(`wire ${u.engine}:`, JSON.stringify(await assertEncryptedWire(u.page, u.engine)));
      }

      /* A real tone in every direction a recorder can measure. WebKit cannot
         decode its own MediaRecorder output, so a direction is unmeasurable
         exactly when the RECEIVER is WebKit — the mesh assertions above are
         what cover those legs. */
      for (const sender of users) {
        for (const receiver of users) {
          if (sender === receiver || receiver.engine === 'webkit') continue;
          await toneRoundTrip(sender.page, receiver.page, 1000, 2000, `triple-${sender.engine}-${receiver.engine}`);
        }
      }

      /* One leaves. Both survivors stay on the air and each drops exactly one
         unit — a mesh that forgets a leaver, or collapses to zero, fails
         here even though every leg was healthy a moment ago. */
      const [leaver, ...survivors] = users;
      if (!leaver) throw new Error('triple needs at least three engines');
      await leaveToJoin(leaver.page);
      for (const u of survivors) {
        await assertScreenVisible(u.page, 'radio');
        await assertPeerCount(u.page, 1);
        await assertPeerChips(u.page, 1);
      }
    } finally {
      await Promise.allSettled(users.map((u) => u.browser.close()));
    }
  });
}
