import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, USE_LOCAL_SERVER, IS_REMOTE } from './e2e/utils/env';
import { FIREFOX_USER_PREFS } from './e2e/utils/media';

const isCI = !!process.env['CI'];

/* Chrome-only fake-device flags; Firefox/WebKit get an in-page getUserMedia
   stub instead (see e2e/utils/media.ts). LocalNetworkAccessChecks: a deployed
   https origin is blocked from wss://localhost by Chrome's local-network
   policy — the remote recipe keeps the broker local + TLS, so the test
   browser must allow it. */
const CHROMIUM_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults',
];

const FIREFOX_PREFS = FIREFOX_USER_PREFS;

const shared = {
  baseURL: BASE_URL,
  headless: process.env['HEADED'] !== 'true',
  video: isCI ? ('retain-on-failure' as const) : ('on' as const),
  trace: 'on-first-retry' as const,
  viewport: { width: 1280, height: 720 },
};

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: shared,
  globalSetup: './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  /* A deployed origin already serves the build; only serve it locally. */
  /* The preview server follows the base URL under test, so the subpath shape
     Pages actually deploys is one env var away:
       BASE_PATH=/wlk1-ghostcom/ npm run build
       E2E_BASE_URL=http://localhost:4173/wlk1-ghostcom npm run test:e2e
     Without this the app asks for /wlk1-ghostcom/assets/... against a server
     that serves at /, and every lane fails on a 404 — which is what happened
     the first time CI was given a subpath base. */
  webServer: USE_LOCAL_SERVER
    ? {
        command: `npx vite preview --port 4173 --base=${new URL(BASE_URL).pathname}`,
        port: 4173,
        reuseExistingServer: !isCI,
      }
    : undefined,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...shared, launchOptions: { args: CHROMIUM_ARGS } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], ...shared, launchOptions: { firefoxUserPrefs: FIREFOX_PREFS } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], ...shared },
    },
  ],
});

if (IS_REMOTE) console.log(`[playwright] running against deployed origin: ${BASE_URL}`);