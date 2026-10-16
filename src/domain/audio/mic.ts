/* ═══════════════════════════════════════════════════════════════
   audio/mic.ts — cold-mic policy with a WARM WINDOW.

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

export type GetUserMediaFn = (constraints: MediaStreamConstraints) => Promise<MediaStream>;
export type TimerHandle = ReturnType<typeof setTimeout>;

const defaultGum: GetUserMediaFn = async (constraints) => {
  const md = globalThis.navigator?.mediaDevices;
  if (!md) throw new Error('NO MEDIA API — USE HTTPS');
  return md.getUserMedia(constraints);
};

export interface MicManagerOptions {
  getUserMedia?: GetUserMediaFn;
  warmWindowMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (t: TimerHandle) => void;
  log?: (msg: string, kind?: string) => void;
}

export interface MicAcquisition {
  stream: MediaStream;
  track: MediaStreamTrack | undefined;
  generation: number;
}

export type EndedHandler = () => void;

export class MicManager {
  stream: MediaStream | null;
  hot = false;          // hardware capturing AND enabled
  warm = false;         // hardware alive but muted (warm window)

  private _gum: GetUserMediaFn;
  private _warmMs: number;
  private _setTimeout: (fn: () => void, ms: number) => TimerHandle;
  private _clearTimeout: (t: TimerHandle) => void;
  private _log: (msg: string, kind?: string) => void;
  private _warmTimer: TimerHandle | null;
  private _gen: number;             // generation token — invalidates stale async paths
  private _inflight = 0;            // acquires awaiting hardware — warm-up yields to these
  private _endedHandlers: Set<EndedHandler>;

  constructor({
    getUserMedia = defaultGum,
    warmWindowMs = WARM_WINDOW_MS,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (t) => clearTimeout(t),
    log = () => {},
  }: MicManagerOptions = {}) {
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

  onEnded(fn: EndedHandler): void { this._endedHandlers.add(fn); }

  /** A cached stream is reusable only while it holds live audio tracks.
      Test doubles without readyState count as live; 'ended' never does. */
  private _liveAudioTracks(s: MediaStream | null): MediaStreamTrack[] | null {
    if (!s) return null;
    const tracks = s.getAudioTracks();
    if (!tracks.length) return null;
    const isLive = (t: MediaStreamTrack): boolean => {
      const rs: unknown = (t as unknown as { readyState?: unknown }).readyState;
      return rs === undefined || rs === 'live';
    };
    return tracks.every(isLive) ? tracks : null;
  }

  /**
   * Acquire the mic. Resolves {stream, track, generation}.
   * The returned generation must be checked before any side effect:
   *   const {generation} = await mic.acquire();
   *   if (generation !== mic.generation) return; // gesture was cancelled
   */
  async acquire(): Promise<MicAcquisition> {
    this._inflight++;
    try { return await this._acquire(); } finally { this._inflight--; }
  }

  private async _acquire(): Promise<MicAcquisition> {
    let gen: number = ++this._gen;
    if (this.warm && this.stream) {
      const live = this._liveAudioTracks(this.stream);
      if (!live) {
        this.release();            // corpse (OS revoked / device lost) — fall to cold path
        gen = this._gen;
      } else {
        if (this._warmTimer != null) this._clearTimeout(this._warmTimer);
        this._warmTimer = null;
        live.forEach((t) => { t.enabled = true; });
        this.warm = false;
        this.hot = true;
        this._log('MIC WARM-RESUME — 0ms WAKE', 'sys');
        return { stream: this.stream, track: live[0], generation: gen };
      }
    }
    if (this.hot && this.stream) {
      const live = this._liveAudioTracks(this.stream);
      if (!live) {
        this.release();            // corpse — fall through to cold getUserMedia
        gen = this._gen;
      } else {
        return { stream: this.stream, track: live[0], generation: gen };
      }
    }
    /* Cross-browser constraints: echoCancellation is widely supported;
       noiseSuppression / autoGainControl are ideal-only so Safari and
       Firefox fall back instead of throwing OverconstrainedError. */
    const tries: MediaStreamConstraints[] = [
      { audio: { echoCancellation: true, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true } }, video: false },
      { audio: { echoCancellation: true }, video: false },
      { audio: true, video: false },
    ];
    let stream: MediaStream | null = null, lastErr: unknown = null;
    for (const c of tries) {
      try { stream = await this._gum(c); break; } catch (e) { lastErr = e; }
    }
    if (!stream) throw (lastErr ?? new Error('MIC BLOCKED')) as Error;
    if (gen !== this._gen) {                       // cancelled while awaiting HW
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('MIC ACQUIRE CANCELLED');
    }
    this.stream = stream;
    this.hot = true;
    this.warm = false;
    for (const t of stream.getAudioTracks()) {
      (t as MediaStreamTrack & { addEventListener?: MediaStreamTrack['addEventListener'] }).addEventListener?.('ended', () => {
        if (this.stream === stream) this._hardReset();
        for (const fn of this._endedHandlers) fn();
      });
    }
    this._log('MIC HOT — HARDWARE CAPTURING', 'sys');
    return { stream, track: stream.getAudioTracks()[0], generation: gen };
  }

  /** Join-time warm-up: take the hardware now and drop straight into the
      warm window, so the permission prompt and the cold-device wake are
      paid by the JOIN instead of press #1. Never throws — a blocked mic
      must still fail on press #1 with the existing honest UI, not break
      the join. */
  async warmUp(): Promise<void> {
    /* Yield to a press that is already arming. Starting a second acquire
       bumps the generation token and would cancel that press outright —
       the join must never be the reason a PTT press fails. The check and
       the acquire() call below are one synchronous run, so a press cannot
       slip in between them. */
    if (this.hot || this.warm || this._inflight > 0) return;
    try {
      const { generation } = await this.acquire();
      /* A press that started mid-warm owns the hardware now; muting it
         here would silence a live TX. acquire() already killed our
         in-flight stream in that race — just stand down. */
      if (generation !== this.generation) return;
      this.mute();
    } catch { /* denied / no device — the first press reports it */ }
    /* shortcut: a press landing BEFORE this resolves still pays the cold
       path once (the press wins the race, and its stream is the one kept —
       correct, just not instant). The browser's permission dialog is modal,
       so no real press can arrive while one is open; upgrade to sharing one
       in-flight acquire if a caller ever needs sub-gesture presses fast. */
  }

  /** TX released → mute + start warm window (hardware stays alive briefly). */
  mute(): void {
    if (!this.stream) return;
    this.hot = false;
    this.warm = true;
    this.stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    if (this._warmTimer != null) this._clearTimeout(this._warmTimer);
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
  release(): void {
    ++this._gen;
    if (this._warmTimer != null) this._clearTimeout(this._warmTimer);
    this._warmTimer = null;
    if (!this.stream) return;
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    this.stream = null;
    this.hot = false;
    this.warm = false;
    this._log('MIC RELEASED — HW OFF • 0.0W CAPTURE', 'sys');
  }

  /** Generation token — compare against acquire() results to abort stale work. */
  get generation(): number { return this._gen; }

  _hardReset(): void {
    this.stream = null;
    this.hot = false;
    this.warm = false;
    ++this._gen;
    if (this._warmTimer != null) this._clearTimeout(this._warmTimer);
    this._warmTimer = null;
  }
}
