import { Page, expect } from '@playwright/test';
import {
  injectTxTrack,
  startTx,
  endTx,
  startRecording,
  stopRecording,
  analyzeAudio,
  verifyAudio,
  saveAudio,
} from '../fixtures/audio';

/** Wait for an open broker connection.
    NOTE: waitForFunction(fn, arg, options) — options are THIRD. Passed
    second they become `arg` and the wait never times out. */
export async function waitForPeerId(page: Page, timeout = 30000): Promise<void> {
  await waitForBrokerConnected(page, timeout);
}

/** User-visible equivalent of "the app has a live broker connection":
    the sync bar is what a person reads. Waiting on window.mesh.peer.id
    instead would test an internal, not the experience. */
export async function waitForBrokerConnected(page: Page, timeout = 30000): Promise<void> {
  await expect(page.locator('#syncBar')).toContainText(
    /BROKER CONNECTED|LINK ESTABLISHED|ON CHANNEL/,
    { timeout },
  );
}

/** LNK counts REMOTE units (self is never in the peers map), so a
    2-user room reads LNK 1 with one chip per side. */
export async function waitForMeshLink(pageA: Page, pageB: Page, timeout = 30000): Promise<void> {
  await Promise.all([waitForPeerId(pageA, timeout), waitForPeerId(pageB, timeout)]);
  await Promise.all([
    expect(pageA.locator('#lnkCount')).toHaveText('1', { timeout }),
    expect(pageB.locator('#lnkCount')).toHaveText('1', { timeout }),
  ]);
  await expect(pageA.locator('.chip')).toHaveCount(1, { timeout: 5000 });
  await expect(pageB.locator('.chip')).toHaveCount(1, { timeout: 5000 });
}

/** Close the first-run hint overlay if it is showing. */
export async function closeHint(page: Page): Promise<void> {
  const go = page.locator('#hintGo');
  if (await go.isVisible().catch(() => false)) {
    await go.click();
    await expect(page.locator('#hint.show')).not.toBeVisible({ timeout: 2000 });
  }
}

/** First gesture: unlock AudioContext + silent-carrier ctx + pending dials.
    The gesture must land AFTER the app has attached its listeners — a tap
    during a slow boot is simply lost, and until the silent carrier runs the
    mesh refuses to build legs at all ("AUDIO NOT READY, RETRY ON TAP"). */
export async function unlockAudio(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.mesh), undefined, { timeout: 30000 });
  await page.keyboard.press('Shift');
}

/**
 * Press keypad digits via real clicks.
 */
export async function pressKeypad(page: Page, ...digits: string[]): Promise<void> {
  for (const d of digits) {
    await page.locator(`.key[data-digit="${d}"]`).click();
    await page.waitForTimeout(50);
  }
}

/** Press a keyboard shortcut and assert the resulting toast. */
export async function pressShortcut(page: Page, key: string, expectedToast?: string): Promise<void> {
  if (expectedToast) {
    await Promise.all([
      page.waitForSelector('#toast.show', { timeout: 5000 }),
      page.keyboard.press(key),
    ]);
    await expect(page.locator('#toast')).toContainText(expectedToast, { timeout: 5000 });
  } else {
    await page.keyboard.press(key);
  }
}

/**
 * Hold PTT using a chosen input path (asserts TX LED lights, then clears).
 */
export async function pttHold(
  page: Page,
  method: 'button' | 'space' | 't' | 'enter',
  durationMs: number,
): Promise<void> {
  if (method === 'button') {
    await page.locator('#ptt').dispatchEvent('pointerdown');
  } else if (method === 'space') {
    await page.locator('#ptt').focus();
    await page.keyboard.down(' ');
  } else if (method === 't') {
    await page.locator('#ptt').focus();
    await page.keyboard.down('t');
  } else if (method === 'enter') {
    await page.locator('#ptt').focus();
    await page.keyboard.down('Enter');
  }

  /* arm + open squelch can take a beat on the first (cold) press */
  await expect(page.locator('#txLed')).toHaveClass(/tx/, { timeout: 10000 });
  await page.waitForTimeout(durationMs);

  if (method === 'button') {
    await page.locator('#ptt').dispatchEvent('pointerup');
  } else if (method === 'space') {
    await page.keyboard.up(' ');
  } else if (method === 't') {
    await page.keyboard.up('t');
  } else if (method === 'enter') {
    await page.keyboard.up('Enter');
  }

  await expect(page.locator('#txLed')).not.toHaveClass(/tx/, { timeout: 5000 });
}

/**
 * The traffic log exactly as the operator reads it on the device.
 * Reading the DOM pane rather than window internals keeps assertions on
 * something a person can actually see on the radio.
 */
export async function appLogs(page: Page): Promise<string[]> {
  return page.locator('#hackLines .body').allTextContents();
}

/**
 * Every frame the E2EE worker silently discarded.
 *
 * The tone round trip proves a sound CAN arrive. It cannot prove we are not
 * throwing most of the stream away on the way — that gap is how the app
 * shipped a cross-engine leg that connected, reported E2EE ARMED, and
 * dropped 100% of its frames while the badge stayed green.
 *
 * Returns null when the browser has no encoded-transform support at all
 * (no worker exists, so there is nothing to count and nothing to claim).
 */
async function frameDrops(page: Page): Promise<{ drops: number; encCount: number; decCount: number } | null> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      mesh?: { e2ee?: { stats: () => Promise<{ drops: number; encCount: number; decCount: number }> } | null };
    };
    const e2ee = w.mesh?.e2ee;
    if (!e2ee) return null;
    const s = await e2ee.stats();
    return { drops: s.drops ?? 0, encCount: s.encCount ?? 0, decCount: s.decCount ?? 0 };
  });
}

/**
 * Assert the E2EE pipeline discarded nothing, and hand back the counts so
 * the run shows whether frames actually moved.
 *
 * Honest limit, measured not assumed: on the headless Chromium in this
 * repo's CI, `onrtctransform` fires but encoded frames are never delivered
 * to the worker, so the counts are zero on BOTH fields and a passing result
 * here is necessary but not sufficient. Play a tone round trip through a
 * WebKit peer to exercise the pipeline for real. Returns the stats so a
 * caller can log them instead of passing silently.
 */
export async function assertNoFrameDrops(
  page: Page,
  who: string,
): Promise<{ drops: number; encCount: number; decCount: number }> {
  const stats = await frameDrops(page);
  expect(stats, `${who}: no E2EE worker — cannot count frame drops`).not.toBeNull();
  const s = stats!;
  expect(s.drops, `${who}: E2EE worker discarded ${s.drops} frame(s) — frames are being silently dropped`).toBe(0);
  return s;
}

/**
 * Inject a tone on pageTx, transmit it through the mesh, record pageRx
 * DURING the transmission, then verify frequency/level/duration.
 * (Sequential ptt-then-record can never catch the tone.)
 */
export async function toneRoundTrip(
  pageTx: Page,
  pageRx: Page,
  freq: number,
  holdMs: number,
  label: string,
): Promise<void> {
  await injectTxTrack(pageTx, freq, holdMs + 1500);
  await startTx(pageTx);

  await pageRx.waitForTimeout(400); // let the track reach the sender chain
  const handle = await startRecording(pageRx);
  await pageRx.waitForTimeout(holdMs);
  const audio = await stopRecording(pageRx, handle);

  await endTx(pageTx);

  const analysis = await analyzeAudio(pageRx, audio);
  analysis.passed = verifyAudio(analysis, freq, holdMs);
  await saveAudio(audio, label);
  expect(analysis.passed, `tone ${freq}Hz — analysis ${JSON.stringify(analysis)}`).toBe(true);
}

/** Adjust volume slider by absolute percent. */
export async function adjustVolume(page: Page, targetPercent: number): Promise<void> {
  const slider = page.locator('#volSlider');
  await slider.fill(String(targetPercent));
  await slider.dispatchEvent('input');
  await slider.dispatchEvent('change');
}

/** Open settings from the radio via the keypad gear key. */
export async function openSettings(page: Page): Promise<void> {
  await closeHint(page);
  await page.locator('#keySettings').click();
  await expect(page.locator('#view-settings')).toBeVisible({ timeout: 5000 });
}

/** Back to the radio from settings. */
export async function closeSettings(page: Page): Promise<void> {
  await page.locator('#setBack').click();
  await expect(page.locator('#view-radio')).toBeVisible({ timeout: 5000 });
}

/** Mic path check via the keypad MIC key. */
export async function testMicPath(page: Page): Promise<void> {
  await page.locator('#keyMic').click();
  await expect(page.locator('#toast')).toContainText('MIC OK', { timeout: 8000 });
}

/** Two PTT cycles: cold then warm (warm window keeps the hardware hot). */
export async function testWarmWindow(page: Page): Promise<void> {
  await pttHold(page, 'button', 1000);
  await page.waitForTimeout(100);
  const start = Date.now();
  await pttHold(page, 'button', 1000);
  console.log(`[WarmWindow] second PTT cycle took ${Date.now() - start}ms`);
}

/**
 * Rotate identity and return the new share link. Peer IDs are
 * HMAC(secret, slot), so a rotated secret makes the peer un-discoverable to
 * the old room: the link MUST drop, and the room is reachable again only
 * through the freshly shared link.
 */
export async function testNewIdentity(page: Page): Promise<string> {
  await page.locator('#newIdentityBtn').click();
  await expect(page.locator('#toast')).toContainText('NEW IDENTITY', { timeout: 8000 });
  await expect(page.locator('#lnkCount')).toHaveText('0', { timeout: 20000 });
  return page.evaluate(() => location.hash);
}

/** Leave the radio back to the join screen. */
export async function leaveToJoin(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-join')).toBeVisible({ timeout: 5000 });
}

/** Passphrase join: channel + words + remember, expect radio. */
export async function testPassphraseJoin(page: Page, channel: string, passphrase: string): Promise<void> {
  await page.locator('#joinChannel').fill(channel);
  await page.locator('#tabPass').click();
  await page.locator('#joinPass').fill(passphrase);
  await page.locator('#rememberMe').check();
  await page.locator('#joinBtn').click();
  await expect(page.locator('#view-radio')).toBeVisible({ timeout: 20000 });
}

/**
 * Click a recent room. Secret-carrying recents join directly (radio);
 * no-secret recents land in passphrase mode on the join screen.
 */
export async function testRecentRoom(page: Page, index: number, expectScreen: 'radio' | 'join'): Promise<void> {
  await page.locator('.recent-chip').nth(index).click();
  await expect(page.locator(`#view-${expectScreen}`)).toBeVisible({ timeout: 20000 });
}

/** Simulate tab hide/show (visibility change). */
export async function simulateTabHide(page: Page, durationMs = 3000): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(durationMs);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Simulate network offline/online. */
export async function simulateOffline(page: Page, durationMs = 2000): Promise<void> {
  await page.context().setOffline(true);
  await page.waitForTimeout(durationMs);
  await page.context().setOffline(false);
}

/** Share channel link via keypad SHARE key. */
export async function testShare(page: Page): Promise<void> {
  await page.locator('#keyShare').click();
  await expect(page.locator('#toast')).toContainText('LINK COPIED', { timeout: 8000 });
}

/** Copy logs from settings. */
export async function testCopyLogs(page: Page): Promise<void> {
  await page.locator('#setCopyLogs').click();
  await expect(page.locator('#toast')).toContainText('LOGS COPIED', { timeout: 8000 });
}
