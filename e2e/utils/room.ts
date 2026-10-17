/**
 * Room bootstrap for journey specs.
 *
 * Every journey gets its own two fresh browser contexts (the `alice`/`bob`
 * fixtures are test-scoped), so a journey can never inherit or corrupt
 * another journey's session. This helper only does the shared prologue:
 * generate a secret, open the share link on both sides, unlock audio, wait
 * for the mesh link, and dismiss the first-run hint.
 */

import { Page } from '@playwright/test';
import { waitForMeshLinkAll, closeHint, unlockAudio } from './mesh-helpers';
import { BASE_URL, BROKER_CONFIG, ROOM_CHANNEL, INJECT_BROKER } from './env';

export { BROKER_CONFIG, BASE_URL };

/** Crockford base32 room secret, matching src/domain/crypto/crypto.ts. */
export function generateRoomSecret(): string {
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** Point a page at our broker — a no-op when we must use the app default. */
export async function applyBrokerConfig(page: Page): Promise<void> {
  if (!INJECT_BROKER) return;
  await page.addInitScript((cfg) => { window.WLK1_CONFIG = cfg; }, BROKER_CONFIG);
}

/** Point both pages at the local broker before any app code runs. */
export async function useLocalBroker(pages: Page[]): Promise<void> {
  await Promise.all(pages.map(applyBrokerConfig));
}

export interface Room {
  secret: string;
  link: string;
}

/**
 * Boot both pages into the same fresh room and wait until they are linked.
 * `dismissHint: false` leaves the first-run hint open so a journey can assert
 * that it actually appeared.
 */
export async function joinRoomAll(
  pages: Page[],
  { channel = ROOM_CHANNEL, dismissHint = true }: { channel?: string; dismissHint?: boolean } = {},
): Promise<Room> {
  const secret = generateRoomSecret();
  const link = `${BASE_URL}/#${channel}.${secret}`;

  await Promise.all(pages.map((p) => p.goto(link, { waitUntil: 'networkidle' })));
  await Promise.all(pages.map(unlockAudio));
  await waitForMeshLinkAll(pages, pages.length - 1);
  if (dismissHint) await Promise.all(pages.map(closeHint));

  return { secret, link };
}

/** Boot both pages into the same fresh room and wait until they are linked.
    `dismissHint: false` leaves the first-run hint open so a journey can assert
    that it actually appeared. */
export async function joinRoom(
  pageA: Page,
  pageB: Page,
  opts: { channel?: string; dismissHint?: boolean } = {},
): Promise<Room> {
  return joinRoomAll([pageA, pageB], opts);
}