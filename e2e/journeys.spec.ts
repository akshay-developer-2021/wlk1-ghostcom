import { test, expect } from '@playwright/test';
import { test as radioTest, newColdMicContext } from './fixtures/browser';
import {
  waitForMeshLink,
  waitForBrokerConnected,
  closeHint,
  unlockAudio,
  leaveToJoin,
  pressShortcut,
  pressKeypad,
  pttHold,
  toneRoundTrip,
  adjustVolume,
  openSettings,
  testMicPath,
  testWarmWindow,
  testNewIdentity,
  testPassphraseJoin,
  testRecentRoom,
  testCopyLogs,
  simulateTabHide,
  simulateOffline,
  appLogs,
  assertNoFrameDrops,
} from './utils/mesh-helpers';
import {
  assertLcdShows,
  assertPeerCount,
  assertPeerChips,
  assertScreenVisible,
  assertSyncBar,
  assertTxLed,
  assertMicLed,
  assertBattery,
  assertVolume,
  assertPassphraseStrength,
  assertEncryptionBadgeHonest,
  assertJoinError,
  assertHintModal,
  assertBrokerSaved,
} from './utils/assertions';
import { joinRoom, useLocalBroker, applyBrokerConfig, generateRoomSecret, BASE_URL } from './utils/room';
import { ROOM_CHANNEL } from './utils/env';
import { COLD_MIC_MS, needsFakeMicStub } from './utils/media';

radioTest.describe.configure({ retries: 0, timeout: 180_000 });

/**
 * Each journey owns its own room: the alice/bob fixtures are test-scoped, so
 * a failure in one journey can never mask or corrupt another.
 */

radioTest('boot & link: the share link joins both users and every indicator matches the live leg', async ({ alice, bob, logs }) => {
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== BOOT & LINK ===');
  const secret = await bootWithHint(pageA, pageB);

  await assertScreenVisible(pageA, 'radio');
  await assertScreenVisible(pageB, 'radio');
  await assertLcdShows(pageA, '22');
  await assertLcdShows(pageB, '22');

  /* LNK counts remote units only — a 2-user room reads 1 */
  await assertPeerCount(pageA, 1);
  await assertPeerCount(pageB, 1);
  await assertPeerChips(pageA, 1);
  await assertPeerChips(pageB, 1);
  await assertSyncBar(pageA, 'LINK ESTABLISHED — LISTENING');
  await assertEncryptionBadgeHonest(pageA);
  expect(secret).toMatch(/^#\d{2}\.[0-9A-Z]{16}$/);
});

radioTest('lone survivor: when one user leaves, the other stays on the radio with an honest empty link', async ({ alice, bob, logs }) => {
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== LONE SURVIVOR ===');
  const { link } = await joinRoom(pageA, pageB);

  console.log('[1] one user leaves the room');
  await leaveToJoin(pageA);

  console.log('[2] survivor keeps the radio, drops to LNK 0, chip removed, banner honest');
  await assertScreenVisible(pageB, 'radio');
  await assertLcdShows(pageB, '22');
  await assertPeerCount(pageB, 0);
  await assertPeerChips(pageB, 0);
  await assertSyncBar(pageB, 'ON CHANNEL — NO OTHER UNITS');

  console.log('[3] the survivor re-links when the peer comes back with the link');
  await pageA.goto(link, { waitUntil: 'networkidle' });
  await unlockAudio(pageA);
  await closeHint(pageA);
  await waitForMeshLink(pageA, pageB);
});

radioTest('radio basics: rolling dial, shortcuts, volume, and every PTT input path', async ({ alice, bob, logs }) => {
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== RADIO BASICS ===');
  await joinRoom(pageA, pageB);

  console.log('[1] rolling dial 33 scans empty, stays dialed, dials back to 22');
  await pressKeypad(pageA, '3', '3');
  await assertLcdShows(pageA, '33');
  await pressKeypad(pageA, '2', '2');
  await assertLcdShows(pageA, '22');

  console.log('[2] shortcuts: mic test, share link, copy logs');
  await pressShortcut(pageA, 'm', 'MIC OK');
  await pressShortcut(pageA, 's', 'LINK COPIED');
  await pressShortcut(pageA, 'l', 'LOGS COPIED');

  console.log('[3] volume slider + arrow keys');
  await adjustVolume(pageA, 50);
  await assertVolume(pageA, 50);
  await pageA.keyboard.press('ArrowUp');
  await pageA.keyboard.press('ArrowDown');

  console.log('[4] PTT via button, Space, T, Enter');
  await pttHold(pageA, 'button', 3000);
  await assertTxLed(pageA, '');
  await assertMicLed(pageA, false);
  await pttHold(pageA, 'space', 2000);
  await pttHold(pageA, 't', 2000);
  await pttHold(pageA, 'enter', 2000);
});

radioTest('audio loopback: a real tone crosses the mesh in both directions', async ({ alice, bob, logs, browserName }) => {
  /* WebKit records via MediaRecorder but decodeAudioData cannot decode its
     own output (EncodingError), so the received tone cannot be measured
     there. Skipped with a reason rather than passing vacuously. */
  test.skip(browserName === 'webkit', 'WebKit decodeAudioData cannot decode MediaRecorder output');
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== AUDIO LOOPBACK ===');
  await joinRoom(pageA, pageB);

  console.log('[1] A→B 1kHz');
  await toneRoundTrip(pageA, pageB, 1000, 3000, 'alice-to-bob-1khz');
  console.log('[2] B→A 440Hz');
  await toneRoundTrip(pageB, pageA, 440, 3000, 'bob-to-alice-440hz');
  console.log('[3] no lingering TX');
  await assertTxLed(pageA, '');
  await assertTxLed(pageB, '');

  /* A tone arriving proves a sound CAN cross. It does not prove we are not
     silently discarding the rest of the stream — that gap is exactly how a
     leg can connect, read E2EE ARMED, and still drop every frame. */
  console.log('[4] the E2EE pipeline discarded nothing');
  console.log(`    alice ${JSON.stringify(await assertNoFrameDrops(pageA, 'alice'))}`);
  console.log(`    bob   ${JSON.stringify(await assertNoFrameDrops(pageB, 'bob'))}`);
});

radioTest('settings & persistence: broker override survives a reload, logs copy, identity rotates', async ({ alice, bob, logs }) => {
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== SETTINGS & PERSISTENCE ===');
  const { link } = await joinRoom(pageA, pageB);

  console.log('[1] open settings from the keypad gear');
  await openSettings(pageA);
  await assertScreenVisible(pageA, 'settings');

  console.log('[2] broker override persists across a reload');
  await pageA.locator('#setHost').fill('custom.broker.local');
  await pageA.locator('#setSave').click();
  await assertBrokerSaved(pageA, 'custom.broker.local');
  /* the reload is the app's own button — wait for THAT load event, or the
     next goto() races location.reload() and the navigation is lost */
  const reloaded = pageA.waitForEvent('load');
  await pageA.locator('#setReload').click();
  await reloaded;
  await pageA.goto(link, { waitUntil: 'networkidle' });
  await unlockAudio(pageA);
  await closeHint(pageA);
  await waitForMeshLink(pageA, pageB);

  console.log('[3] copy logs from settings');
  await openSettings(pageA);
  await testCopyLogs(pageA);

  console.log('[4] new identity darkens the old room; the shared link restores it');
  const newLink = await testNewIdentity(pageA);
  await pageB.goto(`${BASE_URL}/${newLink}`, { waitUntil: 'networkidle' });
  await unlockAudio(pageB);
  await closeHint(pageB);
  await waitForMeshLink(pageA, pageB);
});

radioTest('join screen: validation feedback, passphrase rooms, and both recent-room shapes', async ({ alice, bob, logs }) => {
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== JOIN SCREEN ===');
  await joinRoom(pageA, pageB);

  /* a rolled dial leaves a keyless recent behind — the shape FLOW [5] needs */
  console.log('[0] rolling dial 33 records a keyless recent, then dial back');
  await pressKeypad(pageA, '3', '3');
  await assertLcdShows(pageA, '33');
  await pressKeypad(pageA, '2', '2');
  await assertLcdShows(pageA, '22');
  /* the 22 rejoin must SETTLE (its claim is the newest log line) before the
     next join, otherwise that join is refused as "already running" */
  await expect.poll(async () => {
    const lines = await appLogs(pageA);
    return lines.at(-1) ?? '';
  }).toContain('CLAIMED — CH 22');

  console.log('[1] Escape leaves to the join screen');
  await leaveToJoin(pageA);

  console.log('[2] join validation feedback');
  await pageA.locator('#joinChannel').fill('ab');
  await pageA.locator('#joinBtn').click();
  await assertJoinError(pageA, 'ENTER A 2-DIGIT CHANNEL (00–99)');
  await pageA.locator('#joinChannel').fill('22');
  await pageA.locator('#tabPass').click();
  await pageA.locator('#joinPass').fill('weak');
  await pageA.locator('#joinBtn').click();
  await assertJoinError(pageA, 'PASSPHRASE TOO WEAK — 3+ WORDS OR 16+ CHARS');
  await assertPassphraseStrength(pageA, 0);

  console.log('[3] passphrase join — both sides derive the same room');
  const passphrase = 'strong passphrase words here';
  await testPassphraseJoin(pageA, '22', passphrase);
  await leaveToJoin(pageB);
  await testPassphraseJoin(pageB, '22', passphrase);
  await waitForMeshLink(pageA, pageB);

  console.log('[4] recent with a saved key goes straight to the radio');
  await leaveToJoin(pageA);
  await testRecentRoom(pageA, 0, 'radio');

  console.log('[5] recent without a key lands in passphrase mode with an empty meter');
  await leaveToJoin(pageA);
  await testRecentRoom(pageA, 1, 'join');
  await assertPassphraseStrength(pageA, 0);
  await testRecentRoom(pageA, 0, 'radio');
});

radioTest('resilience: tab hide/show and offline/online both recover the link', async ({ alice, bob, logs }) => {
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== RESILIENCE ===');
  await joinRoom(pageA, pageB);

  console.log('[1] tab hide/show');
  await simulateTabHide(pageA, 3000);
  await waitForMeshLink(pageA, pageB);

  console.log('[2] offline/online');
  await simulateOffline(pageA, 2000);
  await waitForMeshLink(pageA, pageB);
});

radioTest('power & audio path: battery, PTT wake lock, mic test, warm window', async ({ alice, bob, logs }) => {
  const { page: pageA } = alice;
  const { page: pageB } = bob;
  await useLocalBroker([pageA, pageB]);

  console.log('\n=== POWER & AUDIO PATH ===');
  await joinRoom(pageA, pageB);

  console.log('[1] battery readout');
  await assertBattery(pageA);
  await assertBattery(pageB);

  console.log('[2] PTT takes and releases the wake lock');
  await pttHold(pageA, 'button', 1000);

  console.log('[3] mic test');
  await testMicPath(pageA);

  console.log('[4] cold → warm → cold');
  await testWarmWindow(pageA);
});

/** Boot both pages, assert the first-run hint appears, then dismiss it. */
async function bootWithHint(pageA: import('@playwright/test').Page, pageB: import('@playwright/test').Page): Promise<string> {
  const { link } = await joinRoom(pageA, pageB);
  // joinRoom dismisses the hint; prove it is gone rather than merely assumed
  await assertHintModal(pageA, false);
  return link.replace(/^.*#/, '#');
}

/**
 * bug #2 — the first PTT press must open the squelch on its own.
 *
 * Deliberately NOT the alice/bob fixtures: those pre-grant the mic, and
 * Chromium's --use-fake-ui-for-media-stream auto-accepts a prompt anyway, so
 * every other journey has always run with an already-warm mic. That
 * pre-approval is precisely why this bug reached users with a green suite.
 */
radioTest('cold mic: one press opens the squelch when nothing was pre-approved', async ({ browser, browserName }) => {
  /* Engines that rely on the in-page fake mic cannot run this: the stub
     never installs there (see needsFakeMicStub), so getUserMedia falls
     through to the real API and is denied, which is a different failure
     from the one under test. Chromium uses --use-fake-device-for-media-stream
     and is the only engine here with a working mic. */
  test.skip(needsFakeMicStub(browserName), 'fake-mic stub does not install on this engine — real getUserMedia is denied instead');
  const context = await newColdMicContext(browser);
  const page = await context.newPage();
  try {
    console.log('\n=== COLD MIC / FIRST PRESS ===');
    await applyBrokerConfig(page);
    await page.goto(`${BASE_URL}/#${ROOM_CHANNEL}.${generateRoomSecret()}`, { waitUntil: 'networkidle' });
    await unlockAudio(page);
    await closeHint(page);
    await waitForBrokerConnected(page);

    console.log(`[1] the JOIN absorbs the ${COLD_MIC_MS}ms unanswered-mic cost`);
    /* Precondition, asserted on the visible traffic log: the operator has
       joined and can see the net before reaching for the button. */
    await expect
      .poll(async () => (await appLogs(page)).join('\n'), { timeout: 30_000 })
      .toContain('MIC MUTED — WARM WINDOW');

    console.log('[2] ONE press arms the squelch');
    const armedAt = Date.now();
    await page.locator('#ptt').dispatchEvent('pointerdown');
    /* generous wait on purpose: we want the real arm latency MEASURED, not
       the assertion doing the measuring by timing out */
    await expect(page.locator('#txLed')).toHaveClass(/tx/, { timeout: 30_000 });
    const armMs = Date.now() - armedAt;
    await page.waitForTimeout(500);
    await page.locator('#ptt').dispatchEvent('pointerup');
    await expect(page.locator('#txLed')).not.toHaveClass(/tx/, { timeout: 5000 });

    /* the symptom: the join absorbed the cost, so press #1 did not */
    expect(armMs, `first press armed in ${armMs}ms against a ${COLD_MIC_MS}ms cold mic`).toBeLessThan(1000);
    /* the mechanism: it resumed the join's hardware, not a fresh grant */
    expect(await appLogs(page), 'first press must warm-resume').toContain('MIC WARM-RESUME — 0ms WAKE');
    console.log(`[3] first press armed in ${armMs}ms — no second press needed`);
  } finally {
    await context.close();
  }
});