import { Page, expect } from '@playwright/test';

/** LCD shows the given channel. */
export async function assertLcdShows(page: Page, channel: string): Promise<void> {
  await expect(page.locator('#lcd')).toContainText(`CH ${channel}`, { timeout: 5000 });
}

/** LNK counts remote units only, so a 2-user room reads 1. */
export async function assertPeerCount(page: Page, count: number): Promise<void> {
  await expect(page.locator('#lnkCount')).toHaveText(String(count), { timeout: 10000 });
}

export async function assertPeerChips(page: Page, count: number): Promise<void> {
  await expect(page.locator('.chip')).toHaveCount(count, { timeout: 5000 });
}

export async function assertScreenVisible(page: Page, screen: 'radio' | 'join' | 'settings'): Promise<void> {
  await expect(page.locator(`#view-${screen}`)).toBeVisible({ timeout: 5000 });
}

export async function assertToast(page: Page, text: string): Promise<void> {
  await expect(page.locator('#toast.show')).toContainText(text, { timeout: 5000 });
}

export async function assertSyncBar(page: Page, text: string): Promise<void> {
  await expect(page.locator('#syncBar')).toContainText(text, { timeout: 5000 });
}

/** 'tx' | 'rx' while transmitting/receiving, '' when idle. */
export async function assertTxLed(page: Page, expected: 'tx' | 'rx' | ''): Promise<void> {
  if (expected) await expect(page.locator('#txLed')).toHaveClass(new RegExp(expected), { timeout: 5000 });
  else await expect(page.locator('#txLed')).not.toHaveClass(/tx|rx/, { timeout: 5000 });
}

export async function assertMicLed(page: Page, on: boolean): Promise<void> {
  if (on) await expect(page.locator('#micLed')).toHaveClass(/tx/, { timeout: 5000 });
  else await expect(page.locator('#micLed')).not.toHaveClass(/tx/, { timeout: 5000 });
}

export async function assertBattery(page: Page): Promise<void> {
  await expect(page.locator('#batt')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#batt')).toContainText(/PWR/, { timeout: 5000 });
}

export async function assertVolume(page: Page, percent: number): Promise<void> {
  await expect(page.locator('#volVal')).toHaveText(String(percent), { timeout: 5000 });
}

/**
 * The badge must never overclaim. Encoded transforms (the frame-level E2EE
 * path) are Chromium/Safari only; on a browser without them the honest badge
 * is SRTP. Asserting the right one per browser is the point — a browser that
 * cannot encrypt frames must not be allowed to display "E2E".
 */
export async function assertEncryptionBadgeHonest(page: Page): Promise<void> {
  const enc = page.locator('.enc');
  await expect(enc).toBeVisible({ timeout: 5000 });
  const canEncryptFrames = await page.evaluate(() => {
    const proto = (globalThis as { RTCRtpSender?: { prototype: object } }).RTCRtpSender?.prototype;
    if (!proto) return false;
    const p = proto as object & { createEncodedStreams?: unknown };
    return 'transform' in proto || typeof p.createEncodedStreams === 'function';
  });
  if (canEncryptFrames) await expect(enc).toContainText('E2E', { timeout: 10000 });
  else await expect(enc).toContainText('SRTP', { timeout: 10000 });
}

export async function assertJoinError(page: Page, message: string): Promise<void> {
  await expect(page.locator('#joinErr')).toHaveText(message, { timeout: 5000 });
}

export async function assertRecentRooms(page: Page, count: number): Promise<void> {
  await expect(page.locator('.recent-chip')).toHaveCount(count, { timeout: 5000 });
}

export async function assertPassphraseStrength(page: Page, level: number): Promise<void> {
  await expect(page.locator('#passFill')).toHaveAttribute('data-level', String(level), { timeout: 5000 });
}

export async function assertHintModal(page: Page, visible: boolean): Promise<void> {
  if (visible) await expect(page.locator('#hint.show')).toBeVisible({ timeout: 5000 });
  else await expect(page.locator('#hint.show')).not.toBeVisible({ timeout: 5000 });
}

export async function assertBrokerSaved(page: Page, host: string): Promise<void> {
  await assertToast(page, 'BROKER SAVED');
  await expect(page.locator('#setHost')).toHaveValue(host, { timeout: 5000 });
}