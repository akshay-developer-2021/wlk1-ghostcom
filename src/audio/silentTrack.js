/* audio/silentTrack.js — a real (silent) audio track to guarantee
   every WebRTC leg has an audio m-line + sender even when our mic
   is cold. This is what makes hot-attach (replaceTrack) possible
   without renegotiation, and prevents "TX to nobody" failures. */

let silentCtx = null;
let cachedTrack = null;

export function getSilentTrack() {
  if (cachedTrack && cachedTrack.readyState === 'live') return cachedTrack;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC || !globalThis.RTCRtpSender) return null; // caller falls back to empty stream
  try {
    silentCtx = silentCtx || new AC({ sampleRate: 16000 });
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
  return t ? new MediaStream([t]) : new MediaStream();
}
