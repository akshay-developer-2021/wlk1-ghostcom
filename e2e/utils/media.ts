/**
 * Fake microphone input for the whole browser matrix.
 *
 * Chromium has --use-fake-device-for-media-stream. Firefox and WebKit have
 * no equivalent flag, so getUserMedia is stubbed in-page with a real sine
 * tone routed into a MediaStreamDestination. The app still exercises its real
 * mic path (generation tokens, PTT-gated release, LED, teardown) — only the
 * OS device is simulated.
 */

/** Init script: install the stub before any app code runs.
    Every value it needs must live INSIDE the function: Playwright injects
    init scripts as a serialized function body, so module-scope constants
    (TONE_HZ) are not in scope in the page and reading one throws
    ReferenceError. Measured: the stub installed and then blew up on the
    first getUserMedia call. Defaults, not closure. */
export const FAKE_MIC_SCRIPT = (toneHz = 220): void => {
  const Real = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  let ctx: AudioContext | null = null;

  navigator.mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints) => {
    /* video is not part of this app — fail the way a real device would */
    if (constraints.video) throw new DOMException('no camera', 'NotFoundError');

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new DOMException('no webaudio', 'NotSupportedError');

    if (!ctx) ctx = new Ctor({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = toneHz;
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    osc.connect(gain).connect(dest);
    osc.start();

    void Real;   // the real API stays reachable for anyone who wants it
    return dest.stream;
  };
};

/**
 * Simulate a cold, not-yet-answered mic.
 *
 * Every other spec runs with the mic effectively pre-approved: the alice/bob
 * fixtures call grantPermissions(), and Chromium's
 * --use-fake-ui-for-media-stream auto-accepts a prompt anyway.
 *
 * What a real prompt does to the app is hold the FIRST getUserMedia call
 * open until the user answers; once answered, the grant persists and every
 * later call resolves immediately. This reproduces exactly that on whatever
 * getUserMedia is installed above it, so the app takes the same cold path a
 * first-time visitor takes on the first PTT press.
 *
 * Must be registered AFTER FAKE_MIC_SCRIPT so it wraps the engine's stub.
 */
export const COLD_MIC_SCRIPT = (delayMs: number): void => {
  const md = navigator.mediaDevices;
  if (!md) return;
  const inner = md.getUserMedia.bind(md);
  let answered = false;
  md.getUserMedia = async (constraints: MediaStreamConstraints) => {
    if (!answered) {
      answered = true;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return inner(constraints);
  };
};

/** How long the unanswered first prompt is modelled to hold getUserMedia
    open. Large enough to be unmistakable in a timeline, small enough that a
    suite does not spend its life waiting. */
export const COLD_MIC_MS = 2500;

/**
 * Firefox prefs the suite needs, in one place because they have to be passed
 * at every launch site: a manual browserType.launch() does NOT inherit the
 * running project's launchOptions, so a cross-engine lane that launches its
 * own Firefox gets stock defaults unless it passes these itself.
 *
 * All three are privacy defaults meant for real users:
 *   · media.autoplay.block-webaudio — Web Audio stays suspended until the page
 *     has sticky activation, which a headless runner never accumulates. The
 *     shared silent context then never runs and the mesh refuses to dial.
 *   · media.peerconnection.ice.loopback — two peers on one runner have only
 *     loopback to pair on; without this there is nothing to gather.
 *   · …obfuscate_host_addresses — mDNS-mangles host candidates that never
 *     resolve between two processes on the same machine.
 */
export const FIREFOX_USER_PREFS: Record<string, boolean | number> = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'permissions.default.microphone': 1,
  'media.autoplay.block-webaudio': false,
  'media.autoplay.default': 0,
  'media.autoplay.blocking_policy': 0,
  'media.peerconnection.ice.loopback': true,
  'media.peerconnection.ice.obfuscate_host_addresses': false,
};

/** Chromium-only: prefers the real fake device so the OS pipeline is used. */
export function needsFakeMicStub(browserName: string): boolean {
  return browserName !== 'chromium';
}

/**
 * Permission names differ per engine, and WebKit accepts a clipboard-write
 * grant only to fail on the next newPage(). Verified by probing each engine:
 * WebKit has no clipboard-write; Chromium has all four.
 *
 * Firefox has NO Playwright permission name for the microphone at all
 * ("Unknown permission: microphone"), but it does not need one: the
 * firefoxUserPrefs in playwright.config.ts set
 * `permissions.default.microphone: 1` and
 * `media.navigator.permission.disabled: true`, which pre-approve the mic
 * natively. Calling grantPermissions there only threw and failed every
 * test, so Firefox is left to its prefs.
 */
const PERMISSIONS: Record<string, string[]> = {
  chromium: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
  webkit: ['microphone', 'camera', 'clipboard-read'],
};

export async function grantMicPermissions(
  context: { grantPermissions: (p: string[]) => Promise<void> },
  browserName: string,
): Promise<void> {
  const permissions = PERMISSIONS[browserName];
  if (!permissions) return;                 // firefox: pre-approved via user prefs
  await context.grantPermissions(permissions);
}