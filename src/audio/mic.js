/* ═══════════════════════════════════════════════════════════════
   audio/mic.js — cold-mic policy with a WARM WINDOW.

   · Hardware OFF by default. getUserMedia only on TX press.
   · After TX release the track is muted (enabled=false) and kept
     for WARM_WINDOW_MS: next PTT re-enables in ~0ms instead of
     paying 150–500ms getUserMedia hardware wake.
   · After the window expires the track is stop()ped — OS mic
     indicator disappears, zero capture drain, full privacy.
   · Every state change goes through a generation token so a
     released button can never latch a live mic (tap-race fix).
   ═══════════════════════════════════════════════════════════════ */

export const WARM_WINDOW_MS = 45_000;

const defaultGum = async (constraints) => {
  const md = globalThis.navigator?.mediaDevices;
  if (!md) throw new Error('NO MEDIA API — USE HTTPS');
  return md.getUserMedia(constraints);
};

export class MicManager {
  constructor({
    getUserMedia = defaultGum,
    warmWindowMs = WARM_WINDOW_MS,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (t) => clearTimeout(t),
    log = () => {},
  } = {}) {
    this._gum = getUserMedia;
    this._warmMs = warmWindowMs;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    this._log = log;
    this.stream = null;
    this.hot = false;          // hardware capturing AND enabled
    this.warm = false;         // hardware alive but muted (warm window)
    this._warmTimer = null;
    this._gen = 0;             // generation token — invalidates stale async paths
    this._endedHandlers = new Set();
  }

  onEnded(fn) { this._endedHandlers.add(fn); }

  /**
   * Acquire the mic. Resolves {stream, track, generation}.
   * The returned generation must be checked before any side effect:
   *   const {generation} = await mic.acquire();
   *   if (generation !== mic.generation) return; // gesture was cancelled
   */
  async acquire() {
    const gen = ++this._gen;
    if (this.warm && this.stream) {
      this._clearTimeout(this._warmTimer);
      this._warmTimer = null;
      this.stream.getAudioTracks().forEach((t) => { t.enabled = true; });
      this.warm = false;
      this.hot = true;
      this._log('MIC WARM-RESUME — 0ms WAKE', 'sys');
      return { stream: this.stream, track: this.stream.getAudioTracks()[0], generation: gen };
    }
    if (this.hot && this.stream) {
      return { stream: this.stream, track: this.stream.getAudioTracks()[0], generation: gen };
    }
    const stream = await this._gum({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (gen !== this._gen) {                       // cancelled while awaiting HW
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('MIC ACQUIRE CANCELLED');
    }
    this.stream = stream;
    this.hot = true;
    this.warm = false;
    for (const t of stream.getAudioTracks()) {
      t.addEventListener?.('ended', () => {
        if (this.stream === stream) this._hardReset();
        for (const fn of this._endedHandlers) fn();
      });
    }
    this._log('MIC HOT — HARDWARE CAPTURING', 'sys');
    return { stream, track: stream.getAudioTracks()[0], generation: gen };
  }

  /** TX released → mute + start warm window (hardware stays alive briefly). */
  mute() {
    if (!this.stream) return;
    this.hot = false;
    this.warm = true;
    this.stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    this._clearTimeout(this._warmTimer);
    if (this._warmMs > 0) {
      this._warmTimer = this._setTimeout(() => this.release(), this._warmMs);
    } else {
      this.release();
    }
    this._log('MIC MUTED — WARM WINDOW ' + Math.round(this._warmMs / 1000) + 's', 'sys');
  }

  /** Full hardware release — the privacy guarantee.
      Always bumps the generation token so an in-flight acquire
      (started by a PTT press that was already released) is
      invalidated and its stream destroyed on arrival. */
  release() {
    ++this._gen;
    this._clearTimeout(this._warmTimer);
    this._warmTimer = null;
    if (!this.stream) return;
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    this.stream = null;
    this.hot = false;
    this.warm = false;
    this._log('MIC RELEASED — HW OFF • 0.0W CAPTURE', 'sys');
  }

  /** Generation token — compare against acquire() results to abort stale work. */
  get generation() { return this._gen; }

  _hardReset() {
    this.stream = null;
    this.hot = false;
    this.warm = false;
    ++this._gen;
    this._clearTimeout(this._warmTimer);
    this._warmTimer = null;
  }
}
