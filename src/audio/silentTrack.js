/* audio/silentTrack.js — a real (silent) audio track to guarantee
   every WebRTC leg has an audio m-line + sender even when our mic
   is cold. This is what makes hot-attach (replaceTrack) possible
   without renegotiation, and prevents "TX to nobody" failures. */

let silentCtx = null;
let cachedTrack = null;

/* Resume (or create) the shared silent AudioContext. Must run inside a
   user gesture on Safari, otherwise the context stays suspended and the
   track never goes live — which breaks outbound legs cross-browser. */
export function resumeSilentContext() {
  try {
    if (silentCtx?.state === 'suspended') silentCtx.resume().catch(() => {});
    else if (!silentCtx) getSilentTrack();
    else if (silentCtx.state === 'suspended') silentCtx.resume().catch(() => {});
  } catch { /* noop */ }
}

export function hasSilentTrack() {
  return !!(cachedTrack && cachedTrack.readyState === 'live');
}

export function getSilentTrack() {
  if (cachedTrack && cachedTrack.readyState === 'live') return cachedTrack;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC || !globalThis.RTCRtpSender) return null; // caller must guard (no empty-stream dial)
  try {
    if (!silentCtx) {
      try {
        silentCtx = new AC({ sampleRate: 16000 });
      } catch {
        silentCtx = new AC(); // older Safari rejects sampleRate option
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
    const track = dest.stream.getAudioTracks()[0];
    if (track) {
      // hint the sender toward minimal idle cost
      try { track.contentHint = 'speech'; } catch { /* noop */ }
      cachedTrack = track;
    }
    return track || null;
  } catch {
    return null;
  }
}

export function silentStream() {
  const t = getSilentTrack();
  if (typeof MediaStream === 'undefined') return null;   // non-browser (tests)
  // NOTE: null (not empty stream) when no track — callers must skip the
  // dial instead of offering a trackless m-line Safari/Firefox reject.
  return t ? new MediaStream([t]) : null;
}
