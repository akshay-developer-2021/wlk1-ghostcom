import { test as base, BrowserContext, Page, TestInfo } from '@playwright/test';
import { mergeVideos, checkFFmpeg } from '../utils/video-merge';
import { LogCollector, LogEntry } from './log-collector';
import { FAKE_MIC_SCRIPT, needsFakeMicStub, grantMicPermissions, COLD_MIC_SCRIPT, COLD_MIC_MS } from '../utils/media';
import { TLS_BROKER, INJECT_BROKER } from '../utils/env';

interface TestFixtures {
  alice: { context: BrowserContext; page: Page };
  bob: { context: BrowserContext; page: Page };
  logs: LogEntry[];
  mergedVideoPath: string;
}

interface RadioContextOptions {
  /** false = leave permissions untouched, as a first-time visitor arrives. */
  grant?: boolean;
  /** Hold getUserMedia open, as an unanswered permission prompt does. */
  coldMicMs?: number;
}

async function newRadioContext(
  browser: import('@playwright/test').Browser,
  opts: RadioContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    recordVideo: {
      dir: 'test-results/videos/',
      size: { width: 1280, height: 720 },
    },
    /* An injected TLS broker is self-signed (test artifact) — the context
       must accept it or every wss handshake dies. */
    ignoreHTTPSErrors: TLS_BROKER && INJECT_BROKER,
  });
  if (opts.grant !== false) await grantMicPermissions(context, browser.browserType().name());
  /* Firefox/WebKit have no fake-device flag — stub getUserMedia instead */
  if (needsFakeMicStub(browser.browserType().name())) {
    await context.addInitScript(FAKE_MIC_SCRIPT);
  }
  /* registered last so it wraps whatever the engine ended up with */
  if (opts.coldMicMs) await context.addInitScript(COLD_MIC_SCRIPT, opts.coldMicMs);
  return context;
}

/** A context with NO pre-granted permissions and an unanswered mic prompt.
    The standard fixtures pre-approve the mic, which is exactly why the
    first-press bug reached users behind a green suite. */
export function newColdMicContext(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
  return newRadioContext(browser, { grant: false, coldMicMs: COLD_MIC_MS });
}

export const test = base.extend<TestFixtures>({
  alice: async ({ browser }, use) => {
    const context = await newRadioContext(browser);
    const page = await context.newPage();
    await use({ context, page });
    await context.close();
  },

  bob: async ({ browser }, use) => {
    const context = await newRadioContext(browser);
    const page = await context.newPage();
    await use({ context, page });
    await context.close();
  },

  logs: async ({ alice, bob }, use, testInfo) => {
    const logs: LogEntry[] = [];
    const collector = new LogCollector(logs);
    collector.attach(alice.page, 'alice');
    collector.attach(bob.page, 'bob');
    await use(logs);
    await collector.writeLogFile(testInfo);
  },

  /* Videos are only finalized when the context closes, so this fixture
     owns closing both contexts and merges afterwards. The alice/bob
     fixture teardowns then close an already-closed context (safe). */
  mergedVideoPath: async ({ alice, bob }, use, testInfo) => {
    await use('');
    try {
      const videoAPath = alice.page.video();
      const videoBPath = bob.page.video();
      await alice.context.close();
      await bob.context.close();
      const videoA = videoAPath ? await videoAPath.path() : null;
      const videoB = videoBPath ? await videoBPath.path() : null;
      if (videoA && videoB && (await checkFFmpeg())) {
        const output = `test-results/merged-${testInfo.title.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}.mp4`;
        await mergeVideos({
          videoA,
          videoB,
          output,
          layout: 'horizontal',
          scale: { width: 1920, height: 540 },
        });
        console.log(`[Video] Merged video saved to ${output}`);
      } else if (videoA && videoB) {
        console.log('[Video] ffmpeg unavailable — raw videos kept in test-results/videos/');
      }
    } catch (err) {
      console.error('[Video] Merge failed:', err);
    }
  },
});

export { expect } from '@playwright/test';
