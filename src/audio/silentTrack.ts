/* audio/silentTrack.ts — a real (silent) audio track to guarantee
   every WebRTC leg has an audio m-line + sender even when our mic
   is cold. This is what makes hot-attach (replaceTrack) possible
   without renegotiation, and prevents "TX to nobody" failures. */

let silentCtx: AudioContext | null = null;
let cachedTrack: MediaStreamTrack | null = null;

type GlobalWithWebkitAC = typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function audioCtxCtor(): typeof AudioContext | null {
  const g = globalThis as GlobalWithWebkitAC;
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** True while the shared silent context is running (audible-safe). */
export function silentContextRunning(): boolean {
  return silentCtx?.state === 'running';
}

/* Resume (or create) the shared silent AudioContext. Must run inside a
   user gesture on Safari, otherwise the context stays suspended and the
   track never goes live — which breaks outbound legs cross-browser. */
export function resumeSilentContext(): void {
  try {
    if (!silentCtx) { getSilentTrack(); return; }
    if (silentCtx.state === 'suspended') silentCtx.resume().catch(() => {});
  } catch { /* noop */ }
}

export function hasSilentTrack(): boolean {
  return !!(cachedTrack && cachedTrack.readyState === 'live');
}

export function getSilentTrack(): MediaStreamTrack | null {
  if (cachedTrack && cachedTrack.readyState === 'live') return cachedTrack;
  const AC = audioCtxCtor();
  if (!AC || !globalThis.RTCRtpSender) return null; // caller must guard (no empty-stream dial)
  try {
    if (!silentCtx) {
      try {
        silentCtx = new AC(); // default sample rate — cheapest, DSP-native
      } catch {
        silentCtx = new AC({ sampleRate: 16000 }); // older Safari rejects the no-arg form
      }
    }
    if (silentCtx.state === 'suspended') silentCtx.resume().catch(() => {});
    const dest = silentCtx.createMediaStreamDestination();
    const osc = silentCtx.createOscillator();
    const gain = silentCtx.createGain();
    gain.gain.value = 0;                       // digital silence, DSP-cheap
    osc.frequency.value = 1;
    osc.connect(gain); gain.connect(dest);
    osc.start();
    const track = dest.stream.getAudioTracks()[0] ?? null;
    if (track) {
      // hint the sender toward minimal idle cost
      try { track.contentHint = 'speech'; } catch { /* noop */ }
      cachedTrack = track;
    }
    return track;
  } catch {
    return null;
  }
}

export function silentStream(): MediaStream | null {
  const t = getSilentTrack();
  if (typeof MediaStream === 'undefined') return null;   // non-browser (tests)
  // NOTE: null (not empty stream) when no track — callers must skip the
  // dial instead of offering a trackless m-line Safari/Firefox reject.
  return t ? new MediaStream([t]) : null;
}
