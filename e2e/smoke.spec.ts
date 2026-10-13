import { test, expect } from '@playwright/test';

// Mic-permission denials surface as console noise on headless/CI browsers
// (no mic device, permission auto-denied) — never a product regression.
const MIC_ALLOWLIST = /mic|permission|allow|denied|notallowed|notfound|audio|device/i;

test('smoke: shell renders with no TypeErrors', async ({ page }) => {
  const typeErrors: string[] = [];

  page.on('pageerror', (err: Error) => {
    const message = err?.message ?? String(err);
    if (/TypeError/.test(message) && !MIC_ALLOWLIST.test(message)) typeErrors.push(message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/TypeError/.test(text) && !MIC_ALLOWLIST.test(text)) typeErrors.push(text);
    }
  });

  await page.goto('/');
  await expect(page).toHaveTitle(/GHOSTCOM/);
  await expect(page.locator('#shell')).toBeVisible();

  // First-run Join/hint screen: click through when it shows; otherwise the
  // radio LCD must already be present (auto-joined session).
  const hint = page.locator('#hint.show');
  if (await hint.isVisible().catch(() => false)) {
    await page.locator('#hintGo').click();
  }
  await expect(page.locator('#lcd')).toBeVisible();
  await expect(page.locator('#freq')).toBeVisible();

  expect(typeErrors).toEqual([]);
});
