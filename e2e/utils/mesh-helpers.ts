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

/**
 * What the page itself knows about a leg that will not come up: the app's own
 * log lines (the same ones the settings screen shows a user) plus live WebRTC
 * state per leg.
 *
 * This exists because "expected LNK 1, received 0" is not a diagnosis. The
 * three ways a leg stalls — the audio context never started, the dialer
 * refused for lack of a sender, ICE gathered nothing on loopback — produce
 * byte-identical assertion output, and each one took a CI round trip to tell
 * apart.
 */
export async function meshDiagnostics(page: Page, tail = 14): Promise<string> {
  return page
    .evaluate(async (tailLines) => {
      const appLog = Array.from(document.querySelectorAll('#hackLines .body'))
        .slice(-tailLines)
        .map((n) => (n.textContent ?? '').trim());
      const mesh = (window as unknown as {
        mesh?: {
          e2ee?: { stats: () => Promise<{ drops: number; encCount: number; decCount: number }> } | null;
          legs?: Map<string, {
            slot: number;
            crypto: boolean | null;
            call: { peer?: string; peerConnection?: RTCPeerConnection | null };
          }>;
        };
      }).mesh;
      if (!mesh) return `no window.mesh; app log:\n  ${appLog.join('\n  ')}`;

      const legs: string[] = [];
      for (const [, leg] of mesh.legs ?? []) {
        const pc = leg.call?.peerConnection ?? null;
        let detail = 'no peerConnection';
        if (pc) {
          const stats = await pc.getStats();
          let pairs = 0, candidates = 0, sent = 0, recv = 0, frames = 0;
          stats.forEach((r) => {
            const v = r as unknown as Record<string, number | string>;
            if (r.type === 'candidate-pair' && v.state === 'succeeded') pairs++;
            if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates++;
            if (r.type === 'outbound-rtp' && r.kind === 'audio') sent += Number(v.bytesSent ?? 0);
            if (r.type === 'inbound-rtp' && r.kind === 'audio') {
              recv += Number(v.bytesReceived ?? 0);
              /* frameCount is Chromium-only and absent in Firefox/WebKit,
                 which report framesDecoded — reading only frameCount prints a
                 confident 0 for a leg that delivered bytes. */
              frames = Math.max(frames, Number(v.frameCount ?? 0), Number(v.framesDecoded ?? 0));
            }
          });
          detail =
            `pc=${pc.connectionState}/ice=${(pc as RTCPeerConnection & { iceConnectionState?: string }).iceConnectionState}` +
            ` senders=${pc.getSenders().length} receivers=${pc.getReceivers().length}` +
            ` txTransform=${pc.getSenders().filter((s) => 'transform' in s).length}` +
            ` rxTransform=${pc.getReceivers().filter((r) => 'transform' in r).length}` +
            ` candidates=${candidates} pairs=${pairs} bytesSent=${sent} bytesRecv=${recv} frames=${frames}`;
        }
        legs.push(`UNIT-${leg.slot} crypto=${String(leg.crypto)} ${detail}`);
      }
      const wire = mesh.e2ee ? await mesh.e2ee.stats() : null;
      const wireLine = wire
        ? `wire enc=${wire.encCount} dec=${wire.decCount} drops=${wire.drops}`
        : 'wire: no e2ee engine';
      return [`legs=${mesh.legs?.size ?? 0}`, wireLine, ...legs, 'app log:', ...appLog.map((l) => `  ${l}`)]
        .join('\n');
    }, tail)
    .catch((err: Error) => `diagnostics failed: ${err.message}`);
}

/**
 * Every page in the room must see `expected` REMOTE units and chips.
 *
 * LNK counts remote units only (self is never in the peers map), so a 2-user
 * room reads LNK 1 and a 3-user room LNK 2.
 *
 * On timeout every page dumps what it knows, so the failure names the cause
 * instead of only the symptom.
 */
export async function waitForMeshLinkAll(pages: Page[], expected: number, timeout = 30000): Promise<void> {
  await Promise.all(pages.map((p) => waitForPeerId(p, timeout)));
  const want = String(expected);
  try {
    await Promise.all(pages.map((p) => expect(p.locator('#lnkCount')).toHaveText(want, { timeout })));
    await Promise.all(pages.map((p) => expect(p.locator('.chip')).toHaveCount(expected, { timeout: 5000 })));
  } catch (err) {
    const dumps = await Promise.all(pages.map((p) => meshDiagnostics(p)));
    throw new Error(
      `${(err as Error).message}\n` + dumps.map((d, i) => `── page ${i + 1} ──\n${d}`).join('\n'),
    );
  }
}

/** Two-user room: LNK 1 on both sides. */
export async function waitForMeshLink(pageA: Page, pageB: Page, timeout = 30000): Promise<void> {
  await waitForMeshLinkAll([pageA, pageB], 1, timeout);
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
 * The counts used to read zero on both fields on Chromium — which reads as
 * "no frames were thrown away" when in fact the transform had been attached
 * after the sender started and the engine was delivering nothing at all.
 * assertEncryptedWire below is the check that tells those two apart; this one
 * is the "nothing discarded" half of the same claim.
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
 * Per-direction counts straight from the two direction-workers.
 *
 * The aggregate above cannot tell "encrypted nothing" from "encrypted
 * everything": both read zero drops when the transform never attached, which
 * is exactly how Chromium shipped cleartext with the badge on.
 */
async function wireStats(page: Page): Promise<{ enc: { drops: number; n: number }; dec: { drops: number; n: number } } | null> {
  return page.evaluate(async () => {
    const e2ee = (window as unknown as { mesh?: { e2ee?: { _enc: Worker; _dec: Worker } | null } }).mesh?.e2ee;
    if (!e2ee) return null;
    const one = (w: Worker, key: 'encCount' | 'decCount'): Promise<{ drops: number; n: number }> =>
      new Promise((res) => {
        const onMsg = (e: MessageEvent): void => {
          if (e.data?.type !== 'stats') return;
          w.removeEventListener('message', onMsg);
          res({ drops: e.data.drops ?? 0, n: e.data[key] ?? 0 });
        };
        w.addEventListener('message', onMsg);
        w.postMessage({ type: 'stats' });
      });
    const [enc, dec] = await Promise.all([one(e2ee._enc, 'encCount'), one(e2ee._dec, 'decCount')]);
    return { enc, dec };
  });
}

/**
 * The frame pipeline is LIVE in both directions.
 *
 * Chromium ignores a transform assigned to a sender/receiver that has already
 * started sending, so an attach that waits for the capability handshake is
 * silently dropped by the engine: the encryptor sees nothing, the peer
 * discards every cleartext frame it receives, and the LCD still reads
 * "E2E ARMED". Both halves have to be observed, because either one alone
 * passes on a pipeline that is not running.
 */
export async function assertEncryptedWire(page: Page, who: string): Promise<{ enc: number; dec: number }> {
  const deadline = Date.now() + 30_000;
  let stats = await wireStats(page);
  /* Frames take a while to flow on a loaded runner: the link reads as
     established the moment the remote description lands, long before ICE,
     DTLS and the first packets. Poll rather than sample once, or the
     assertion measures that gap instead of the pipeline. */
  while (Date.now() < deadline && !(stats && stats.enc.n > 0 && stats.dec.n > 0)) {
    await page.waitForTimeout(250);
    stats = await wireStats(page);
  }
  expect(stats, `${who}: no E2EE worker`).not.toBeNull();
  const s = stats!;
  /* Both counters travel with every failure: enc=0 with dec=0 is a leg that
     moved nothing at all, dec=0 with drops>0 is frames arriving in the clear
     (our inbound transform missing), and drops=0 with dec=0 is a decryptor
     that never ran. Those three need three different fixes. */
  const counts = ` [enc=${s.enc.n} dec=${s.dec.n} encDrops=${s.enc.drops} decDrops=${s.dec.drops}]`;
  expect(s.enc.n, `${who}: encryptor processed no frames — the outbound transform is not attached${counts}`).toBeGreaterThan(0);
  expect(s.dec.n, `${who}: decryptor processed no frames — the inbound transform is not attached${counts}`).toBeGreaterThan(0);
  expect(s.dec.drops, `${who}: decryptor discarded ${s.dec.drops} frame(s) while idle — the peer is not encrypting${counts}`).toBe(0);
  return { enc: s.enc.n, dec: s.dec.n };
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

  /* The sender's slot picks which remote stream the receiver records — the
     one thing that matters as soon as a receiver has more than one peer. */
  const senderSlot = await pageTx.evaluate(
    () => (window as unknown as { mesh?: { slot?: number } }).mesh?.slot ?? 0,
  );

  await pageRx.waitForTimeout(400); // let the track reach the sender chain
  const handle = await startRecording(pageRx, senderSlot);
  await pageRx.waitForTimeout(holdMs);
  const audio = await stopRecording(pageRx, handle);

  await endTx(pageTx);

  const analysis = await analyzeAudio(pageRx, audio);
  analysis.passed = verifyAudio(analysis, freq, holdMs);
  await saveAudio(audio, label);
  if (!analysis.passed) {
    /* Silence has several causes that need different fixes: no media reached
       the receiver, the leg is muted because its crypto verdict never
       settled, or playback is blocked. The receiving page's own state says
       which. */
    const [tx, rx] = await Promise.all([meshDiagnostics(pageTx, 8), meshDiagnostics(pageRx, 8)]);
    throw new Error(
      `tone ${freq}Hz (${label}) — analysis ${JSON.stringify(analysis)}\n── TX ──\n${tx}\n── RX ──\n${rx}`,
    );
  }
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

/** Two PTT cycles: every press pays its own cold hardware wake (no warm
    window; the permission grant persists after the first press). */
export async function testColdCycles(page: Page): Promise<void> {
  await pttHold(page, 'button', 1000);
  await page.waitForTimeout(100);
  const start = Date.now();
  await pttHold(page, 'button', 1000);
  console.log(`[ColdCycles] second PTT cycle took ${Date.now() - start}ms`);
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
