/**
 * Fake microphone input for the whole browser matrix.
 *
 * Chromium has --use-fake-device-for-media-stream. Firefox and WebKit have
 * no equivalent flag, so getUserMedia is stubbed in-page with a real sine
 * tone routed into a MediaStreamDestination. The app still exercises its real
 * mic path (generation tokens, warm window, LED, teardown) — only the OS
 * device is simulated.
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
 * --use-fake-ui-for-media-stream auto-accepts a prompt anyway. Playwright
 * cannot raise a real OS permission dialog headlessly, so that pre-approval
 * is why bug #2 — the first PTT press paying for the permission prompt, the
 * AudioContext gesture and the cold-device wake — never fired in CI.
 *
 * What a real prompt does to the app is hold the getUserMedia promise open
 * until the user answers. This reproduces exactly that, on whatever
 * getUserMedia is installed above it, so the app takes the same cold path a
 * first-time visitor takes.
 *
 * Must be registered AFTER FAKE_MIC_SCRIPT so it wraps the engine's stub.
 */
export const COLD_MIC_SCRIPT = (delayMs: number): void => {
  const md = navigator.mediaDevices;
  if (!md) return;
  const inner = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints: MediaStreamConstraints) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return inner(constraints);
  };
};

/** How long an unanswered permission prompt is modelled to hold gUM open.
    Large enough to be unmistakable in a timeline, small enough that a
    suite does not spend its life waiting. */
export const COLD_MIC_MS = 2500;

/** Chromium-only: prefers the real fake device so the OS pipeline is used. */
export function needsFakeMicStub(browserName: string): boolean {
  return browserName !== 'chromium';
}

/**
 * Permission names differ per engine, and WebKit accepts a clipboard-write
 * grant only to fail on the next newPage(). Verified by probing each engine:
 * WebKit has no clipboard-write; Chromium and Firefox have all four.
 */
const PERMISSIONS: Record<string, string[]> = {
  chromium: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
  firefox: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
  webkit: ['microphone', 'camera', 'clipboard-read'],
};

export async function grantMicPermissions(
  context: { grantPermissions: (p: string[]) => Promise<void> },
  browserName: string,
): Promise<void> {
  const permissions = PERMISSIONS[browserName] ?? PERMISSIONS['chromium']!;
  await context.grantPermissions(permissions);
}