/* ═══════════════════════════════════════════════════════════════
   audio/mic.ts — PTT-gated capture, nothing more.

   · Hardware OFF until a PTT press and released the moment TX ends:
     the only device activation is between press and release, so the
     OS mic indicator can never outlive the gesture.
   · The browser permission prompt therefore lands on the FIRST PTT
     press (one-time; after that the grant persists per origin and
     later presses skip it). A press released while the prompt is
     open cancels cleanly — the stream is stopped on arrival and the
     generation token drops it.
   · Every state change goes through a generation token so a
     released button can never latch a live mic (tap-race fix).
   ═══════════════════════════════════════════════════════════════ */

export type GetUserMediaFn = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

const defaultGum: GetUserMediaFn = async (constraints) => {
  const md = globalThis.navigator?.mediaDevices;
  if (!md) throw new Error('NO MEDIA API — USE HTTPS');
  return md.getUserMedia(constraints);
};

export interface MicManagerOptions {
  getUserMedia?: GetUserMediaFn;
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
  hot = false;          // hardware capturing

  private _gum: GetUserMediaFn;
  private _log: (msg: string, kind?: string) => void;
  private _gen: number;             // generation token — invalidates stale async paths
  private _endedHandlers: Set<EndedHandler>;

  constructor({
    getUserMedia = defaultGum,
    log = () => {},
  }: MicManagerOptions = {}) {
    this._gum = getUserMedia;
    this._log = log;
    this.stream = null;
    this.hot = false;
    this._gen = 0;
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
    let gen: number = ++this._gen;
    if (this.hot && this.stream) {
      const live = this._liveAudioTracks(this.stream);
      if (!live) {
        this.release();            // corpse (OS revoked / device lost) — fall to cold path
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
    for (const t of stream.getAudioTracks()) {
      (t as MediaStreamTrack & { addEventListener?: MediaStreamTrack['addEventListener'] }).addEventListener?.('ended', () => {
        if (this.stream === stream) this._hardReset();
        for (const fn of this._endedHandlers) fn();
      });
    }
    this._log('MIC HOT — HARDWARE CAPTURING', 'sys');
    return { stream, track: stream.getAudioTracks()[0], generation: gen };
  }

  /** Full hardware release — the privacy guarantee. Called the moment TX
      ends, so hardware exists only inside a pressed PTT. Always bumps the
      generation token so an in-flight acquire (started by a PTT press that
      was already released) is invalidated and its stream destroyed on
      arrival. */
  release(): void {
    ++this._gen;
    if (!this.stream) return;
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    this.stream = null;
    this.hot = false;
    this._log('MIC RELEASED — HW OFF • 0.0W CAPTURE', 'sys');
  }

  /** Generation token — compare against acquire() results to abort stale work. */
  get generation(): number { return this._gen; }

  _hardReset(): void {
    this.stream = null;
    this.hot = false;
    ++this._gen;
  }
}
