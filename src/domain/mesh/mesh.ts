/* ═══════════════════════════════════════════════════════════════
   webrtc/mesh.ts — the radio mesh. Rewritten production core.

   Fixes vs. the PoC:
   · Parallel slot claim (join: seconds → sub-second), join mutex,
     full-vs-unreachable diagnosis.
   · Secret-derived peer IDs (crypto.slotPeerId) — rooms cannot be
     enumerated or squatted; inbound calls verified & rejected.
   · Silent-track legs guaranteed to have audio senders → no silent
     TX failures, no 150ms answer hacks.
   · Ghost-leg cleanup on peer-unavailable; symmetric watchdog over
     all known-occupied slots (TX-safe); ICE restart on transient
     disconnect; real broker reconnect fallback.
   · E2EE wired into every sender/receiver; SAS from fingerprints.
   ═══════════════════════════════════════════════════════════════ */

import { Peer, type DataConnection, type LogLevel } from 'peerjs';
import { CONFIG, type AppConfig } from '../../config.js';
import { slotPeerId, callerSlot, sasCode } from '../crypto/crypto.js';
import { set, state, setPeer, removePeer, clearPeers, linkedSlots } from '../state/state.js';
import { silentStream, getSilentTrack, silentContextRunning } from '../audio/silentTrack.js';
import type { MicManager } from '../audio/mic.js';
import type { Sfx } from '../audio/sfx.js';
import type { E2EE } from '../security/e2ee.js';
import type { LogKind } from '../../infra/dom/dom.js';

export interface Leg { call: any /* PeerJS MediaConnection */; slot: number; mode: 'live'|'listen'; crypto: boolean|null; dcOwner?: boolean; recvonly?: boolean; _cryptoTimer?: any; _misses?: number; _neverTimer?: any; _wireTimer?: any; _wireOpen?: boolean; _sasDone?: boolean; _sasListeners?: { ice: (() => void) | null; conn: (() => void) | null } }

export interface TxReport { attached: number; redialed: number }

export interface JoinResult { ok: boolean; reason?: string; slot?: number }

export interface MeshOptions {
  sfx?: Sfx | null;
  mic?: MicManager | null;
  e2ee?: E2EE | null;
  log?: (msg: string, kind?: LogKind) => void;
  config?: AppConfig;
}

export class Mesh {
  sfx: Sfx | null;
  mic: MicManager | null;
  e2ee: E2EE | null;
  log: (msg: string, kind?: LogKind) => void;
  cfg: AppConfig;
  peer: Peer | null = null;
  channel: string | null = null;
  slot = -1;
  legs: Map<string, Leg> = new Map();            // peerId -> Leg
  knownOccupied: Set<number> = new Set();   // slots confirmed occupied (ever linked)
  private _pendingRedial = new Set<number>();
  private _missStrikes = new Map<number, number>(); // slot -> consecutive peer-unavailable strikes
  /* Slots ever linked this channel. Unlike knownOccupied (evicted after
     misses), this is memory: it tells the zero-leg sweep whether anyone
     could possibly be out there. Fresh solo joins stay silent. */
  private _seenPeers = new Set<number>();
  private _roomSecret: string | null = null; // room identity is channel+secret, not channel alone
  private _dialFails = new Map<number, number>(); // slot -> consecutive transport failures (never-connected / ICE / dead dial)
  private _joinMutex: Promise<JoinResult | undefined> | null = null;
  private _rejoinInFlight: Promise<void> | null = null;
  private _reconnectChain = false; // single-flight broker reconnect loop
  private _destroyed = false;
  private _sasPrints = new Map<string, Set<string>>();
  private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private _watchdogTick = 0;
  private _statsTimer: ReturnType<typeof setInterval> | null = null;
  private _visibilityHandler: (() => void) | null = null;
  private _qualityHistory: number[] = [];
  private _txGen = 0;
  private _dataConns = new Map<string, DataConnection>();      // peerId -> crypto-negotiation DataChannel
  private _ourDials = new WeakSet<DataConnection>();          // channels WE opened (vs received)

  constructor({ sfx = null, mic = null, e2ee = null, log = () => {}, config = CONFIG }: MeshOptions = {}) {
    this.sfx = sfx;
    this.mic = mic;
    this.e2ee = e2ee;
    this.log = log;
    this.cfg = config;
  }

  get linked(): number[] { return linkedSlots(); }

  /* Session derives the E2EE engine from the room secret; the mesh only
     negotiates with whatever engine it currently holds. Null = SRTP. */
  setE2ee(e2ee: E2EE | null): void { this.e2ee = e2ee; }

  /* ── JOIN ──────────────────────────────────────────────── */
  /** Drop legs we answered without audio (locked AudioContext pre-gesture).
      The caller has nothing to receive, so staying up just keeps us deaf in
      return; closing it makes the caller redial ~1.5s later, this time with
      the silent carrier attached. */
  redialLockedLegs(): void {
    if (this._destroyed) return;
    for (const [id, leg] of [...this.legs]) {
      if (!leg.recvonly) continue;
      try { leg.call.close(); } catch { /* noop */ }
      this.legs.delete(id);
      this._closeDataConnFor(id);
      removePeer(leg.slot);
      this.log(`UPGRADING RECVONLY LEG — UNIT-${leg.slot}`, 'sys');
    }
    this._emitCrypto();
  }

  async join(channel: string): Promise<JoinResult | undefined> {
    if (this._joinMutex) return this._joinMutex;
    if (this.peer && this.channel === channel) return { ok: true, slot: this.slot };
    this._joinMutex = this._join(channel).finally(() => { this._joinMutex = null; });
    return this._joinMutex;
  }

  async _join(channel: string): Promise<JoinResult> {
    const prevChannel = this.channel;
    const prevSecret = this._roomSecret;
    this.leave();
    /* New room (channel OR secret changed) → forget old faces, or a
       fresh-key manual join inherits strangers and sweeps them forever.
       Same-room rejoin keeps them: the rejoiner is exactly who the
       sweep must rediscover. */
    if (prevChannel !== channel || prevSecret !== state.secret) this._seenPeers.clear();
    this._roomSecret = state.secret ?? null;
    set({ joined: false, connected: false });
    this.channel = channel;
    this.log(`SCANNING CH ${channel}…`, 'sys');

    const secret = state.secret;
    if (!secret) {
      this.log('NO SECRET — JOIN ABORTED', 'warn');
      set({ joined: false });
      return { ok: false, reason: 'no-secret' };
    }

    /* PARALLEL slot claim: race to FIRST open — claim immediately,
       keep collecting stragglers only to destroy them as they resolve.
       4s per-probe timeout stays as backstop. */
    interface SlotAttempt { slot: number; peer?: Peer; result: string }
    let claimed = false;
    let resolveClaim: (v: SlotAttempt | null) => void = () => {};
    const claimP = new Promise<SlotAttempt | null>((res) => { resolveClaim = res; });
    let allResults: SlotAttempt[] = [];
    const destroyProbe = (r: SlotAttempt): void => {
      if (r.peer) { try { r.peer.destroy(); } catch { /* noop */ } }
    };
    const doClaim = (r: SlotAttempt): boolean => {
      if (claimed) return false;
      if (this._destroyed || this.peer || !r.peer || r.peer.destroyed) return false;
      claimed = true;
      this.peer = r.peer;
      this.slot = r.slot;
      set({ joined: true, connected: true });
      this.knownOccupied.clear();
      this._wirePeer(this.peer);
      this.log(`SLOT ${this.slot} CLAIMED — CH ${channel}`, 'sys');
      for (let j = 0; j < this.slot; j++) this._dialListen(j);
      this.sfx?.linkOpen();
      this._startWatchdog();
      resolveClaim(r);
      return true;
    };
    const probeOpts = (): ConstructorParameters<typeof Peer>[1] => ({
      config: { iceServers: this.cfg.iceServers },
      debug: 0 as LogLevel,
      ...(this.cfg.signaling.host
        ? {
            host: this.cfg.signaling.host,
            secure: this.cfg.signaling.secure,
            ...(this.cfg.signaling.port !== undefined ? { port: this.cfg.signaling.port } : {}),
            ...(this.cfg.signaling.path !== undefined ? { path: this.cfg.signaling.path } : {}),
            ...(this.cfg.signaling.key !== undefined ? { key: this.cfg.signaling.key } : {}),
          }
        : {}),
    });
    const attempts: Array<Promise<SlotAttempt>> = [];
    for (let i = 0; i < this.cfg.maxSlots; i++) {
      const pr: Promise<SlotAttempt> = (async (): Promise<SlotAttempt> => {
        /* stagger probes so the broker never sees an 8-socket burst —
           first-open-wins means slot 0 usually claims before the rest
           even start, so this rarely costs latency. */
        await new Promise<void>((r) => setTimeout(r, i * 150));
        /* first-open-wins: a settled claim means our socket is up —
           don't open (and then destroy) another broker socket. This is
           what used to spray "WebSocket closed before established". */
        if (claimed) return { slot: i, result: 'dropped' };
        const id = await slotPeerId(secret, channel, i);
        let p: Peer;
        try {
          p = new Peer(id, probeOpts());
        } catch { return { slot: i, result: 'error' }; }
        const result: string = await new Promise<string>((res) => {
          const t = setTimeout(() => res('timeout'), this.cfg.slotProbeTimeoutMs);
          p.on('open', () => { clearTimeout(t); res('open'); });
          p.on('error', (e) => { clearTimeout(t); res(e.type || 'error'); });
        });
        return { slot: i, peer: p, result };
      })().then(
        (r) => {
          if (r.result === 'open') {
            if (!doClaim(r)) destroyProbe(r);   // late open past claim — destroy
          } else {
            destroyProbe(r);
          }
          return r;
        },
        () => ({ slot: i, result: 'error' } as SlotAttempt),
      );
      attempts.push(pr);
    }

    void Promise.all(attempts).then((all) => {
      allResults = all;
      if (!claimed) resolveClaim(null);
    });

    const first = await claimP;
    if (first && claimed) {
      if (this._destroyed || this.peer !== first.peer) {
        if (this._destroyed) return { ok: false, reason: 'destroyed' };
        return { ok: false, reason: 'superseded' };
      }
      return { ok: true, slot: this.slot };
    }

    if (this._destroyed) return { ok: false, reason: 'destroyed' };
    {
      const reason = this._diagnose(allResults);
      this.log(reason === 'full'
        ? `CH ${channel} FULL — ALL ${this.cfg.maxSlots} SLOTS`
        : 'SIGNAL UNREACHABLE', 'warn');
      set({ joined: false });
      return { ok: false, reason };
    }
  }

  /* FULL only if EVERY resolved probe was unavailable-id (at least one resolved).
     If NO probe resolved (all timeout/dropped) → unreachable (firewalled/blocked). */
  _diagnose(results: Array<{ result: string }>): 'full' | 'unreachable' {
    const resolved = results.filter((r) => r.result !== 'timeout' && r.result !== 'dropped');
    if (resolved.length === 0) return 'unreachable';
    return resolved.every((r) => r.result === 'unavailable-id') ? 'full' : 'unreachable';
  }

  /** Clear all timers atomically before any cleanup. */
  private _clearAllTimers(): void {
    if (this._watchdogTimer != null) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    if (this._statsTimer != null) { clearInterval(this._statsTimer); this._statsTimer = null; }
    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    for (const [, leg] of this.legs) {
      clearTimeout(leg._cryptoTimer);
      clearTimeout(leg._neverTimer);
      clearTimeout(leg._wireTimer);
      try { clearTimeout((leg.call as any)?.__wlkDiscTimer); } catch { /* noop */ }
    }
  }

  leave(keepFlag = false): void {
    if (!keepFlag) this._destroyed = false;
    this._clearAllTimers();
    /* departure signal: a datachannel close does not reliably reach the
       peer on every engine (WebKit), so a graceful leave says BYE first */
    this._broadcastBye();
    for (const [, leg] of this.legs) { try { leg.call.close(); } catch { /* noop */ } }
    this.legs.clear();
    for (const [, conn] of this._dataConns) { try { conn.close(); } catch { /* noop */ } }
    this._dataConns.clear();
    this._pendingRedial.clear();
    this._missStrikes.clear();
    this._dialFails.clear();
    this._watchdogTick = 0;
    clearPeers();
    if (this.peer) { try { this.peer.destroy(); } catch { /* noop */ } this.peer = null; }
    this.slot = -1;
    this.knownOccupied.clear();
    this._sasPrints.clear();
    set({ joined: false, connected: false, sas: null });
  }

  destroy(): void { this._destroyed = true; this._seenPeers.clear(); this._roomSecret = null; this.leave(true); }

  /* ── SIGNALING WIRING ──────────────────────────────────── */
  _wirePeer(p: Peer): void {
    p.on('call', (call) => this._onInbound(call));
    p.on('connection', (conn) => this._onDataConn(conn));

    p.on('error', (e) => {
      const type = e.type || 'error';
      if (type === 'peer-unavailable') {
        /* ghost-leg cleanup: the dialed slot is EMPTY — kill the dead
           leg immediately, every time; evict the slot from
           knownOccupied only after 3 consecutive strikes (a lone
           miss can be a broker race, not a departure). */
        const m = /peer ([\w-]+)/.exec(e.message || '');
        let id = m?.[1];
        if (!id) id = /wlk1-[A-Za-z0-9]+/.exec(e.message || '')?.[0];
        if (id && this.legs.has(id)) {
          const leg = this.legs.get(id);
          if (leg) {
            const strikes = (this._missStrikes.get(leg.slot) ?? 0) + 1;
            this._missStrikes.set(leg.slot, strikes);
            leg._misses = strikes;
            this.legs.delete(id);
            removePeer(leg.slot);
            if (strikes >= 3) {
              this._missStrikes.delete(leg.slot);
              this.knownOccupied.delete(leg.slot);
              this.log(`UNIT-${leg.slot} NOT ON NET — EVICTED AFTER 3 MISSES`, 'warn');
            } else {
              this.log(`UNIT-${leg.slot} NOT ON NET — MISS ${strikes}/3`, 'warn');
            }
          }
        }
        return;
      }
      if (type === 'unavailable-id') { this.log('SLOT RECLAIMED — REJOINING', 'warn'); this._rejoin(); return; }
      this.log(`SIGNAL ERR: ${type}`, 'warn');
    });

    /* Real broker-outage recovery (the PoC swallowed this). Single-flight:
       overlapping 'disconnected' events share one retry chain. */
    p.on('disconnected', () => {
      if (this._destroyed || this.peer !== p || this._reconnectChain) return;
      this._reconnectChain = true;
      set({ connected: false });
      this.log('SIGNAL LOST — RECONNECTING…', 'warn');
      let tries = 0;
      const retry = (): void => {
        if (this._destroyed || !this.peer || this.peer !== p) { this._reconnectChain = false; return; }
        try { p.reconnect(); } catch { /* noop */ }
        this.log(`RECONNECT TRY ${++tries}`, 'sys');
        if (tries < this.cfg.reconnect.maxTries) {
          setTimeout(retry, Math.min(this.cfg.reconnect.baseMs * 2 ** tries, this.cfg.reconnect.maxMs));
        } else {
          this._reconnectChain = false;
          this._rejoin();
        }
      };
      retry();                                    // reconnect immediately, no dead 1.2s
    });

    p.on('open', () => {
      this._reconnectChain = false;
      this._dialFails.clear();
      set({ connected: true });
      /* wedge self-heal: the WebKit wedge takes the signaling socket and
         the legs down together. Once the socket is back with no live
         legs, redial every seen peer (same zero-leg sweep the PTT path
         runs — silent when there is nothing to reach). */
      void this._redialSeenPeers();
    });
  }

  /** Wedge recovery: redial every seen peer while holding no live legs.
      Mirrors the zero-leg sweep in beginTx; socket-open is when a
      stranded radio can reach the room again without a TX. */
  private async _redialSeenPeers(): Promise<void> {
    if (this._destroyed || this.legs.size > 0) return;
    const secret = state.secret;
    const channel = this.channel;
    const live = (this.mic?.stream as MediaStream | null) ?? (silentContextRunning() ? silentStream() : null);
    if (!secret || !channel || !live || this.slot < 0 || this._seenPeers.size === 0) return;
    for (let j = 0; j < this.cfg.maxSlots; j++) {
      if (j === this.slot) continue;
      if ([...this.legs.values()].some((l) => l.slot === j)) continue;
      if (this._destroyed) break;
      if ((this._dialFails.get(j) ?? 0) >= 3) continue; // parked stays parked
      try {
        const id = await slotPeerId(secret, channel, j);
        if (this._destroyed) break;
        const peer = this.peer;
        if (!peer || peer.destroyed) break;
        const call = peer.call(id, live);
        if (call) this._registerLeg(call, j, 'live');
      } catch { /* noop */ }
    }
  }

  async _rejoin(): Promise<void> {
    if (this._destroyed) return;
    if (this._rejoinInFlight) return this._rejoinInFlight;
    this._rejoinInFlight = (async (): Promise<void> => {
      if (this._destroyed) return;
      const ch = this.channel;
      /* Preserve _seenPeers for same-room rejoin (slot conflict). */
      const seenPeers = this._seenPeers;
      this.leave();
      this._seenPeers = seenPeers;
      if (ch && !this._destroyed) await this.join(ch);
    })().finally(() => { this._rejoinInFlight = null; });
    return this._rejoinInFlight;
  }

  /* ── LEGS ──────────────────────────────────────────────── */
  /* Ghost-redial breaker: a dead slot (stale registration, black-holed
     peer) never yields peer-unavailable, so transport failures park it
     after 3 consecutive strikes. force=true is the watchdog slow lane. */
  private _bumpDialFail(slot: number): number {
    const n = (this._dialFails.get(slot) ?? 0) + 1;
    this._dialFails.set(slot, n);
    if (n === 3) this.log(`UNIT-${slot} PARKED`, 'warn');
    return n;
  }

  _dialListen(slot: number, force = false): void {
    if (!this.peer || this.slot < 0) return;
    if (!force && (this._dialFails.get(slot) ?? 0) >= 3) return; // parked — slow lane only
    const secret = state.secret;
    const channel = this.channel;
    if (!secret || !channel) return;
    slotPeerId(secret, channel, slot).then((id) => {
      if (this._destroyed) return;
      const peer = this.peer;
      if (!peer || peer.destroyed) return;
      if (this.legs.has(id)) return;
      /* Pre-gesture (or backgrounded) the shared audio context is locked.
         Never build or resume it here — that logs a console warning AND
         negotiates around a zero-frame source. Skip; the unlock handler
         retries after the first tap, TX redial is the backstop. */
      if (!silentContextRunning()) {
        this.log(`UNIT-${slot} — AUDIO NOT READY, RETRY ON TAP`, 'warn');
        return;
      }
      const stream = silentStream();
      const tracks = typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
      if (!stream || tracks.length === 0) {
        // No sender available (AudioContext locked pre-gesture on Safari).
        // Skip — watchdog / unlock handler retries after first tap.
        this.log(`UNIT-${slot} — AUDIO NOT READY, RETRY ON TAP`, 'warn');
        return;
      }
      let call: ReturnType<Peer['call']> | null = null;
      try {
        call = peer.call(id, stream); // guaranteed audio m-line
      } catch (err) {
        this.log(`DIAL UNIT-${slot} FAILED — ${(err as Error)?.message ?? err}`, 'warn');
        this._bumpDialFail(slot); // redial attempt yielded no stream
        return;
      }
      if (!call) { this.log(`DIAL UNIT-${slot} FAILED — NO CALL`, 'warn'); this._bumpDialFail(slot); return; }
      this._registerLeg(call, slot, 'listen');
      this.log(`LISTEN LEG → UNIT-${slot}`, 'rx');
    }).catch(() => {});
  }

  /* Re-attempt lower-slot dials that were skipped for lack of an audio
     sender (pre-gesture Safari). Safe to call on every unlock. */
  retryPendingDials(): void {
    if (this._destroyed) return;
    this._dialFails.clear(); // explicit user/tap recovery — unpark everything
    if (!this.peer || this.slot < 0 || state.tx) return;
    for (let j = 0; j < this.slot; j++) {
      const has = [...this.legs.values()].some((l) => l.slot === j);
      if (!has) this._dialListen(j);
    }
  }

  _onInbound(call: any): void {
    if (!this.peer) { try { call.close(); } catch { /* noop */ } return; }
    const secret = state.secret;
    const channel = this.channel;
    if (!secret || !channel) {
      this.log('FOREIGN SIGNAL REJECTED', 'warn');
      try { call.close(); } catch { /* noop */ }
      return;
    }
    /* SECURITY: only calls whose ID is a valid secret-derived slot
       for OUR channel are answered. Everything else is dropped. */
    callerSlot(secret, channel, call.peer, this.cfg.maxSlots).then((slot) => {
      if (this._destroyed || !this.peer) { try { call.close(); } catch { /* noop */ } return; }
      if (slot < 0 || slot === this.slot) {
        this.log('FOREIGN SIGNAL REJECTED', 'warn');
        try { call.close(); } catch { /* noop */ }
        return;
      }
      /* Answer with the live mic ONLY while actually transmitting;
         otherwise the silent track (muted-mic leak fix). If the silent
         context is still locked (pre-gesture Safari), answer recvonly
         rather than offering a trackless m-line that breaks negotiation. */
      const mic = this.mic;
      const liveMic: MediaStream | null = (state.tx && mic && mic.hot && mic.stream) || null;
      /* Same gesture rule as dials: no ctx build/resume here (console
         warning + dead source). Locked context → recvonly answer; the
         TX-time redial upgrades the leg when the mic goes live. */
      const sil = liveMic ? null : (silentContextRunning() ? silentStream() : null);
      const silTracks = typeof sil?.getAudioTracks === 'function' ? sil.getAudioTracks() : [];
      let recvonly = false;
      try {
        if (liveMic) call.answer(liveMic);
        else if (sil && silTracks.length) call.answer(sil);
        else { call.answer(); recvonly = true; }
      } catch (err) {
        this.log(`ANSWER UNIT-${slot} FAILED — ${(err as Error)?.message ?? err}`, 'warn');
        try { call.close(); } catch { /* noop */ }
        return;
      }
      const leg = this._registerLeg(call, slot, liveMic ? 'live' : 'listen', false);
      if (recvonly) leg.recvonly = true;
      this.log(`LINK ESTABLISHED — UNIT-${slot}`, 'rx');
      this.sfx?.linkOpen();
      this.sfx?.haptic?.([8, 40, 8]);
    }).catch(() => {
      try { call.close(); } catch { /* noop */ }
    });
  }

  /* dcOwner: this side initiated the media call, so it — and only it —
     dials the crypto DataChannel. A mutual connect() over one peer
     connection deadlocks SCTP (neither channel opens), which showed up
     cross-browser as a permanent E2EE-handshake-timeout / redial loop. */
  _registerLeg(call: any, slot: number, mode: 'live' | 'listen', dcOwner = true): Leg {
    const id = call.peer as string;
    /* orphan kill: a redial/replace must never leave two live
       PeerConnections for the same peer — close the stale one first. */
    const prev = this.legs.get(id);
    if (prev && prev.call !== call) {
      try { prev.call.close(); } catch { /* noop */ }
      clearTimeout(prev._cryptoTimer);
      clearTimeout(prev._neverTimer);
      try { clearTimeout((prev.call as any)?.__wlkDiscTimer); } catch { /* noop */ }
    }
    const leg: Leg = { call, slot, mode, crypto: null, dcOwner };   // null=pending handshake
    this.legs.set(id, leg);
    this.knownOccupied.add(slot);
    /* _seenPeers tracks only slots with PROVEN media — prevents phantom
       sweep dialing after signaling churn. Added only on first media. */
    /* Linked means media-proven, not dialed: chips/count stay truthful
       while outbound probes are still unanswered (no more phantom units).
       Glare re-registers keep a streaming slot lit. */
    setPeer(slot, { linked: state.peers.get(slot)?.stream ? true : false });
    call.on('stream', (remote: MediaStream) => {
      if (this.legs.get(id)?.call !== call) return;   // stale event from a replaced leg
      clearTimeout(leg._neverTimer);
      leg._neverTimer = undefined;
      this._onRemoteStream(slot, remote);
    });
    call.on('close', () => {
      if (this.legs.get(id)?.call !== call) return;   // stale event from a replaced leg — no cross-kill
      this._dropLeg(leg);
    });
    call.on('error', () => {
      if (this.legs.get(id)?.call !== call) return;   // stale event from a replaced leg — no cross-kill
      clearTimeout(leg._cryptoTimer);
      clearTimeout(leg._neverTimer);
      try { clearTimeout(call.__wlkDiscTimer); } catch { /* noop */ }
      if (leg._sasListeners) {
        const pc = call.peerConnection as RTCPeerConnection | null | undefined;
        if (pc) {
          if (leg._sasListeners.ice) pc.removeEventListener('iceconnectionstatechange', leg._sasListeners.ice);
          if (leg._sasListeners.conn) pc.removeEventListener('connectionstatechange', leg._sasListeners.conn);
        }
      }
      this.legs.delete(id);
      this._sasPrints.delete(id);
      this._closeDataConnFor(id);
      removePeer(slot);
      this._emitCrypto();
    });
    this._watchIce(call, slot);
    this._wireSas(call, leg);
    this._negotiateCrypto(call, leg);
    this._armNeverConnected(call, leg);
    this._emitCrypto();
    return leg;
  }

  /** The one teardown for a dead leg — same body the call close path
      always ran. The crypto DataChannel close invokes it too: on WebKit
      remote destroy reliably closes only the dc, never the call. */
  private _dropLeg(leg: Leg): void {
    const call = leg.call;
    const id = call.peer as string;
    try { call.close(); } catch { /* noop */ }
    clearTimeout(leg._cryptoTimer);
    clearTimeout(leg._neverTimer);
    clearTimeout(leg._wireTimer);
    try { clearTimeout(call.__wlkDiscTimer); } catch { /* noop */ }
    if (leg._sasListeners) {
      const pc = call.peerConnection as RTCPeerConnection | null | undefined;
      if (pc) {
        if (leg._sasListeners.ice) pc.removeEventListener('iceconnectionstatechange', leg._sasListeners.ice);
        if (leg._sasListeners.conn) pc.removeEventListener('connectionstatechange', leg._sasListeners.conn);
      }
    }
    this.legs.delete(id);
    this._sasPrints.delete(id);
    this._closeDataConnFor(id);
    removePeer(leg.slot);
    this.log(`LINK DROPPED — UNIT-${leg.slot}`, 'warn');
    this.sfx?.linkLost();
    this._emitCrypto();
  }

  /** DataConn hygiene: close + drop the peer's crypto channel, but only
      when the stored mapping is the one we expect (glare-safe). */
  private _closeDataConnFor(peerId: string): void {
    const conn = this._dataConns.get(peerId);
    if (!conn) return;
    try { conn.close(); } catch { /* noop */ }
    if (this._dataConns.get(peerId) === conn) this._dataConns.delete(peerId);
  }

  /* STUN-only strand: with no TURN, a leg that never connects just sits
     in new/checking/disconnected forever. Tear it down + redial after
     ~10s unless media or a connected state arrives first. */
  private _armNeverConnected(call: any, leg: Leg): void {
    clearTimeout(leg._neverTimer);
    leg._neverTimer = setTimeout(() => {
      try {
        if (this._destroyed) return;
        const id = call.peer as string;
        if (this.legs.get(id)?.call !== call) return;   // replaced — not ours
        const cur = this.legs.get(id);
        if (!cur || cur !== leg) return;
        this.log(`ICE NEVER-CONNECTED — REDIAL UNIT-${leg.slot}`, 'warn');
        this._bumpDialFail(leg.slot);
        try { call.close(); } catch { /* noop */ }
        try { clearTimeout(call.__wlkDiscTimer); } catch { /* noop */ }
        this.legs.delete(id);
        this._closeDataConnFor(id);
        removePeer(leg.slot);
        this._emitCrypto();
        if (state.tx) {
          this._pendingRedial.add(leg.slot);
        } else if (!this._destroyed) {
          const rs = leg.slot;
          setTimeout(() => { if (!this._destroyed) this._dialListen(rs); }, 1500);
        }
      } catch { /* noop */ }
    }, 10_000);
  }

  /* ── E2EE CAPABILITY NEGOTIATION ─────────────────────────
     Frames are encrypted ONLY after the peer proves support over
     a side DataChannel. A peer without Encoded Transforms gets a
     plain SRTP leg instead of garbage audio. Badge reflects truth:
     e2ee = every leg confirmed; mixed = some legs plain. */
  _negotiateCrypto(call: any, leg: Leg): void {
    leg._cryptoTimer = setTimeout(() => this._settleCrypto(leg, false, 'handshake timeout'), 3000);
    let conn: DataConnection | undefined = this._dataConns.get(call.peer);
    /* Reuse only what can still complete: an unopened channel WE dialed is
       dead hardware (adopt it and the handshake hangs forever), while an
       unopened channel we RECEIVED is this non-owner's own channel still
       arriving — that one is adopted either way. */
    if (conn && this._ourDials.has(conn) && !(conn as unknown as { open?: boolean }).open) {
      try { conn.close(); } catch { /* noop */ }
      if (this._dataConns.get(call.peer) === conn) this._dataConns.delete(call.peer);
      conn = undefined;
    }
    if (!conn && leg.dcOwner && this.peer && !this.peer.destroyed && !this._destroyed) {
      try {
        const dc = this.peer.connect(call.peer, { serialization: 'json', reliable: true });
        if (dc) {
          this._dataConns.set(call.peer, dc);
          this._ourDials.add(dc);
          conn = dc;
          this.log(`DC DIAL — UNIT-${leg.slot}`, 'sys');
        } else this.log(`DC DIAL FAILED — UNIT-${leg.slot}`, 'warn');
      } catch { conn = undefined; }
    }
    /* Exactly ONE side owns the crypto channel per leg pair: the side that
       dialed the media. The non-owner never connects — it waits for the
       inbound channel (_onDataConn). Simultaneous connect() on both sides
       deadlocks SCTP: neither channel opens, the hello/ack never lands,
       and every redial repeats the collision (cross-browser symptom:
       E2EE handshake timeout + WIRE NEVER-OPENED loop). */
    if (conn) this._wireCryptoConn(conn, leg);
    else if (leg.dcOwner) { clearTimeout(leg._cryptoTimer); this._settleCrypto(leg, false, 'no data channel'); }

    /* Wire-strand: a leg whose crypto channel never OPENED cannot carry
       BYE/handshake/closes — on engines where the dc builds late (WebKit),
       a departed peer would otherwise wedge one side forever. If the
       channel still is not open ~8s after negotiation, tear the leg down
       and redial; a true peer-unavailable then evicts the slot. */
    clearTimeout(leg._wireTimer);
    leg._wireOpen = false;
    leg._wireTimer = setTimeout(() => {
      try {
        if (this._destroyed) return;
        if (this.legs.get(call.peer)?.call !== call || this.legs.get(call.peer) !== leg) return;
        if (leg._wireOpen) return;
        const conn = this._dataConns.get(call.peer);
        if (conn && (conn as unknown as { open?: boolean }).open) return;
        this.log(`WIRE NEVER-OPENED — REDIAL UNIT-${leg.slot}`, 'warn');
        this._bumpDialFail(leg.slot);
        try { call.close(); } catch { /* noop */ }
        try { clearTimeout(call.__wlkDiscTimer); } catch { /* noop */ }
        this.legs.delete(call.peer);
        this._closeDataConnFor(call.peer);
        removePeer(leg.slot);
        this._emitCrypto();
        if (state.tx) {
          this._pendingRedial.add(leg.slot);
        } else if (!this._destroyed) {
          const rs = leg.slot;
          setTimeout(() => { if (!this._destroyed) this._dialListen(rs); }, 1500);
        }
      } catch { /* noop */ }
    }, 8_000);
  }

  _wireCryptoConn(conn: DataConnection, leg: Leg): void {
    conn.on('open', () => {
      leg._wireOpen = true;
      clearTimeout(leg._wireTimer);
      try { conn.send({ t: 'wlk1-hello', e2ee: !!this.e2ee }); } catch { /* noop */ }
      this.log(`CHANNEL OPEN — UNIT-${leg.slot}`, 'sys');
    });
    conn.on('data', (d: unknown) => {
      const m = (d ?? null) as { t?: unknown; e2ee?: unknown; speaking?: unknown } | null;
      if (!m || typeof m.t !== 'string') return;
      /* remote departed gracefully — same teardown as a dc close */
      if (m.t === 'wlk1-bye') {
        this.log(`BYE RECV — UNIT-${leg.slot}`, 'sys');
        if (this.legs.get(conn.peer) === leg) this._dropLeg(leg);
        return;
      }
      /* presence heartbeat — remote PTT state, independent of crypto */
      if (m.t === 'wlk1-speaking') {
        if (this.legs.get(conn.peer) === leg) setPeer(leg.slot, { speaking: !!m.speaking });
        return;
      }
      if (m.t !== 'wlk1-hello' && m.t !== 'wlk1-ack') return;
      if (m.t === 'wlk1-hello') { try { conn.send({ t: 'wlk1-ack', e2ee: !!this.e2ee }); } catch { /* noop */ } }
      clearTimeout(leg._cryptoTimer);
      this._settleCrypto(leg, !!m.e2ee, m.e2ee ? '' : 'peer lacks transforms');
    });
    conn.on('close', () => {
      if (this._dataConns.get(conn.peer) === conn) this._dataConns.delete(conn.peer);
      /* departed peer: the dc close is the only signal WebKit gives.
         Stale-guarded — the wiring leg must still be current, or a
         redial that reuses this dc once the map entry is gone would
         have already freed a replacement. */
      this.log(`DC CLOSE — UNIT-${leg.slot}`, 'sys');
      const cur = this.legs.get(conn.peer);
      if (cur && cur.call === leg.call) this._dropLeg(cur);
    });
    conn.on('error', () => { this.log(`DC ERROR — UNIT-${leg.slot}`, 'warn'); /* media leg has its own error path */ });
  }

  /** Broadcast local PTT state so peers light our chip/RX LED. Best-effort. */
  sendSpeaking(on: boolean): void {
    for (const [, conn] of this._dataConns) {
      try {
        const dc = conn as unknown as { open?: boolean; send?: (m: unknown) => void };
        if (dc && dc.open && typeof dc.send === 'function') conn.send({ t: 'wlk1-speaking', speaking: on });
      } catch { /* noop */ }
    }
  }

  /* Tell every open dataconn we are leaving — the wire-truth the
     close event cannot be trusted to deliver on every engine. */
  private _broadcastBye(): void {
    for (const [, conn] of this._dataConns) {
      try {
        const dc = conn as unknown as { open?: boolean };
        if (dc && dc.open) {
          conn.send({ t: 'wlk1-bye' });
          this.log(`BYE SENT — ${conn.peer}`, 'sys');
        }
      } catch { /* noop */ }
    }
  }

  /* inbound DataChannel from a peer that initiated negotiation */
  _onDataConn(conn: DataConnection): void {
    this.log(`DC INBOUND — ${conn.peer}`, 'sys');
    const leg = this.legs.get(conn.peer);
    const prev = this._dataConns.get(conn.peer);
    /* A mirror-dial arrived while we already own (or await) our channel:
       keep OURS and close the duplicate. Adopting the inbound orphaned
       the channel that was actually opening — the handshake never settled
       and the leg redialed forever. */
    if (prev && prev !== conn) {
      try { conn.close(); } catch { /* noop */ }
      return;
    }
    this._dataConns.set(conn.peer, conn);
    if (leg) {
      this._wireCryptoConn(conn, leg);
      return;
    }
    /* Glare race: the data channel arrived before its media leg.
       Park it and give the leg 6s to show up — close only if it
       is still orphaned then. */
    conn.on('open', () => {
      const late = this.legs.get(conn.peer);
      if (late) this._wireCryptoConn(conn, late);
    });
    setTimeout(() => {
      if (this._destroyed) return;
      if (!this.legs.has(conn.peer)) {
        try { conn.close(); } catch { /* noop */ }
        if (this._dataConns.get(conn.peer) === conn) this._dataConns.delete(conn.peer);
      }
    }, 6000);
  }

  _settleCrypto(leg: Leg, remoteCapable: boolean, why = ''): void {
    clearTimeout(leg._cryptoTimer);
    leg._cryptoTimer = undefined;
    if (this._destroyed) return;
    if (!leg || !this.legs.has(leg.call.peer)) { this._emitCrypto(); return; }
    const e2ee = this.e2ee;
    const capable = remoteCapable && !!e2ee;
    if (leg.crypto !== capable) {
      if (capable && e2ee) {
        // Badge stays pending until the transforms actually attach.
        const arm = (pc: RTCPeerConnection): void => {
          void this._armE2ee(pc, e2ee, leg.slot).then(() => {
            if (this._destroyed) return;
            if (this.legs.get(leg.call.peer) !== leg) return;
            leg.crypto = true;
            this.log(`UNIT-${leg.slot} — E2EE AES-GCM ARMED`, 'sys');
            this._emitCrypto();
          }).catch(() => {
            if (this._destroyed) return;
            if (this.legs.get(leg.call.peer) !== leg) return;
            leg.crypto = false;
            this.log(`UNIT-${leg.slot} — E2EE UNAVAILABLE (attach failed) — SRTP LEG`, 'warn');
            this._emitCrypto();
          });
        };
        const pc = leg.call.peerConnection as RTCPeerConnection | null | undefined;
        if (pc) {
          arm(pc);
        } else {
          /* peerConnection not exposed yet (glare/renegotiation race) —
             poll briefly before downgrading the leg to SRTP. */
          let tries = 0;
          const poll = (): void => {
            if (this._destroyed) return;
            if (this.legs.get(leg.call.peer) !== leg) return;
            const p = leg.call.peerConnection as RTCPeerConnection | null | undefined;
            if (p) {
              arm(p);
              return;
            }
            tries++;
            if (tries >= 8) {
              leg.crypto = false;
              this.log(`UNIT-${leg.slot} — E2EE UNAVAILABLE (no peerconnection) — SRTP LEG`, 'warn');
              this._emitCrypto();
              return;
            }
            setTimeout(poll, 250);
          };
          setTimeout(() => { if (!this._destroyed) poll(); }, 250);
        }
      } else {
        leg.crypto = capable;
        this.log(`UNIT-${leg.slot} — E2EE UNAVAILABLE (${why}) — SRTP LEG`, 'warn');
      }
    }
    this._emitCrypto();
  }

  private _armE2ee(pc: RTCPeerConnection, e2ee: E2EE, _slot?: number): Promise<void> {
    const run = async (): Promise<void> => {
      const s = this._senderFor(pc);
      if (s) await e2ee.secureSender(s);
      for (const r of pc.getReceivers()) await e2ee.secureReceiver(r);
      pc.addEventListener('track', (ev) => { e2ee.secureReceiver(ev.receiver).catch(() => {}); });
    };
    return run();
  }

  _emitCrypto(): void {
    const legs = [...this.legs.values()];
    let status: string;
    if (!this.e2ee) status = 'srtp-only';
    else if (!legs.length) status = 'ready';
    else if (legs.every((l) => l.crypto === true)) status = 'e2ee';
    else if (legs.some((l) => l.crypto == null)) status = 'pending';
    else if (legs.some((l) => l.crypto === false)) status = 'mixed';
    else status = 'pending';
    emitCrypto(status);
  }

  /* SAS collection runs regardless of capability (fingerprint truth).
     One-shot per leg: the first connected/completed signal (ICE or
     PeerConnection) collects; later flaps are ignored. */
  _wireSas(call: any, leg?: Leg): void {
    if (!this.e2ee) return;
    const markDone = (): boolean => {
      if ((call as any).__wlkSasDone) return true;
      if (leg && leg._sasDone) return true;
      (call as any).__wlkSasDone = true;
      if (leg) leg._sasDone = true;
      return false;
    };
    const attach = (): void => {
      if (this._destroyed) return;
      const pc = call.peerConnection as RTCPeerConnection | null | undefined;
      if (!pc) { setTimeout(attach, 100); return; }
      const check = (): void => {
        const ice = (pc as RTCPeerConnection & { iceConnectionState?: string }).iceConnectionState;
        const con = pc.connectionState;
        if (ice === 'connected' || ice === 'completed' || con === 'connected') {
          if (!markDone()) void this._collectSas(pc, call.peer as string);
        }
      };
      const onChange = (): void => { check(); };
      pc.addEventListener('iceconnectionstatechange', onChange);
      pc.addEventListener('connectionstatechange', onChange);
      if (leg) leg._sasListeners = { ice: onChange, conn: onChange };
      /* the connection can already be up — listeners alone would miss it */
      check();
    };
    attach();
  }

  _onRemoteStream(slot: number, stream: MediaStream): void {
    setPeer(slot, { stream, linked: true }); // first media = proof of life
    this._missStrikes.delete(slot);   // media is proof of life — reset ghost strikes
    this._dialFails.delete(slot);     // media is proof of life — unpark the slot
    this._seenPeers.add(slot);        // only proven peers enter the memory
    this.log(`RX STREAM — UNIT-${slot}`, 'rx');
  }

  /* ── ICE ───────────────────────────────────────────────── */
  _watchIce(call: any, slot: number): void {
    const legOf = (): Leg | undefined => {
      const leg = this.legs.get(call.peer);
      return leg?.call === call ? leg : undefined;
    };
    const teardownRedial = (why: string): void => {
      const leg = legOf();
      if (!leg) return;                        // stale event — not our leg anymore
      this._bumpDialFail(slot); // transport failure — one strike toward parking
      clearTimeout(leg._cryptoTimer);
      clearTimeout(leg._neverTimer);
      try { clearTimeout(call.__wlkDiscTimer); } catch { /* noop */ }
      try { call.close(); } catch { /* noop */ }
      if (this.legs.get(call.peer)?.call === call) this.legs.delete(call.peer);
      this._closeDataConnFor(call.peer);
      removePeer(slot);
      this._emitCrypto();
      if (state.tx) {
        this._pendingRedial.add(slot);
        this.log(`${why} — REDIAL UNIT-${slot} DEFERRED UNTIL TX END`, 'warn');
      } else if (!this._destroyed) {
        this.log(`${why} — REDIAL UNIT-${slot}`, 'warn');
        setTimeout(() => { if (!this._destroyed) this._dialListen(slot); }, 1500);
      }
    };
    const attach = (): void => {
      if (this._destroyed) return;
      const pc = call.peerConnection as RTCPeerConnection | null | undefined;
      if (!pc) { setTimeout(attach, 100); return; }
      pc.addEventListener('connectionstatechange', () => {
        if (this.legs.get(call.peer)?.call !== call) return;   // stale leg — ignore
        const st = pc.connectionState;
        if (st === 'disconnected') {
          /* transient — try ICE restart first (sub-second recovery).
             Safari often sticks in disconnected instead of failing, so
             schedule a TX-safe redial if it never recovers. */
          this.log(`ICE BLIP — RESTARTING UNIT-${slot}`, 'warn');
          try { (pc as RTCPeerConnection & { restartIce?: () => void }).restartIce?.(); } catch { /* noop */ }
          clearTimeout(call.__wlkDiscTimer);
          call.__wlkDiscTimer = setTimeout(() => {
            try {
              if (this._destroyed) return;
              if (this.legs.get(call.peer)?.call !== call) return;
              const cur = pc.connectionState;
              if ((cur === 'disconnected' || cur === 'failed') && this.legs.has(call.peer)) {
                if (this.legs.get(call.peer)?.call !== call) return;
                if (state.tx) {
                  /* mid-TX: never disturb the air — defer until endTx drains it */
                  this._pendingRedial.add(slot);
                  this.log(`ICE STUCK (${cur}) — REDIAL UNIT-${slot} DEFERRED UNTIL TX END`, 'warn');
                } else {
                  this.log(`ICE STUCK (${cur}) — REDIAL UNIT-${slot}`, 'warn');
                  this._bumpDialFail(slot); // torn-down stuck leg counts toward parking
                  try { call.close(); } catch { /* noop */ }
                  if (this.legs.get(call.peer)?.call === call) this.legs.delete(call.peer);
                  this._closeDataConnFor(call.peer);
                  removePeer(slot);
                  this._emitCrypto();
                  setTimeout(() => { if (!this._destroyed) this._dialListen(slot); }, 1500);
                }
              }
            } catch { /* noop */ }
          }, 5000);
        } else if (st === 'failed' || st === 'closed') {
          clearTimeout(call.__wlkDiscTimer);
          teardownRedial('ICE FAILED');
        } else if (st === 'connected' || (st as string) === 'completed') {
          clearTimeout(call.__wlkDiscTimer);
          this._dialFails.delete(slot); // connected is proof of life — unpark
          const leg = legOf();
          if (leg) { clearTimeout(leg._neverTimer); leg._neverTimer = undefined; }
        }
      });
      /* STUN-only strand: iceConnectionState is the earlier signal on
         bare-STUN paths — clear the never-connected timer on success,
         tear down promptly on terminal ice failure. */
      pc.addEventListener('iceconnectionstatechange', () => {
        if (this.legs.get(call.peer)?.call !== call) return;   // stale leg — ignore
        const ist = (pc as RTCPeerConnection & { iceConnectionState?: string }).iceConnectionState;
        if (ist === 'connected' || (ist as string) === 'completed') {
          clearTimeout(call.__wlkDiscTimer);
          this._dialFails.delete(slot); // connected is proof of life — unpark
          const leg = legOf();
          if (leg) { clearTimeout(leg._neverTimer); leg._neverTimer = undefined; }
        } else if (ist === 'failed' || (ist as string) === 'closed') {
          clearTimeout(call.__wlkDiscTimer);
          teardownRedial('ICE FAILED');
        }
      });
    };
    attach();
  }

  /* ── TX ────────────────────────────────────────────────── */
  /** Attach a live mic track to every leg. Returns delivery report. */
  async beginTx(track: MediaStreamTrack): Promise<TxReport> {
    const report: TxReport = { attached: 0, redialed: 0 };
    const stale = [...this.legs.entries()];
    const redialSlots: number[] = [];
    for (const [id, leg] of stale) {
      if (leg.recvonly) {
        /* answered bare pre-gesture — no sender to hot-swap, needs a
           real live offer */
        try { leg.call.close(); } catch { /* noop */ }
        this.legs.delete(id);
        this._closeDataConnFor(id);   // the redial must not inherit a dying channel
        removePeer(leg.slot);
        redialSlots.push(leg.slot);
        continue;
      }
      const pc = leg.call.peerConnection as RTCPeerConnection | null | undefined;
      const sender = pc ? this._senderFor(pc) : null;
      if (sender) {
        try {
          await sender.replaceTrack(track);
          report.attached++;
          /* encrypt only on legs whose peer proved E2EE capability.
             Awaited: a TX that opens before the re-arm lands would go out
             in the clear while the LCD still reads E2EE. Its own try —
             a crypto failure must not tear down a leg whose audio is fine. */
          const cur = this.legs.get(id);
          if (cur?.crypto === true && this.e2ee) {
            try {
              await this.e2ee.secureSender(sender);
            } catch {
              cur.crypto = false;
              this.log(`UNIT-${leg.slot} — E2EE RE-ARM FAILED — THIS TX IS PLAINTEXT`, 'warn');
              this._emitCrypto();
            }
          }
        } catch {
          this.log(`TX ATTACH UNIT-${leg.slot} FAILED — QUEUED FOR REDIAL`, 'warn');
          try { leg.call.close(); } catch { /* noop */ }
          this.legs.delete(id);
          this._closeDataConnFor(id);   // the redial must not inherit a dying channel
          removePeer(leg.slot);
          redialSlots.push(leg.slot);
        }
      } else {
        /* leg with no audio sender — redial it with the live stream */
        try { leg.call.close(); } catch { /* noop */ }
        this.legs.delete(id);
        this._closeDataConnFor(id);   // the redial must not inherit a dying channel
        removePeer(leg.slot);
        redialSlots.push(leg.slot);
      }
    }
    const secret = state.secret;
    const channel = this.channel;
    const live = this.mic?.stream ?? null;
    if (redialSlots.length && secret && channel && live) {
      for (const rs of redialSlots) {
        if (this._destroyed) break;
        try {
          const id = await slotPeerId(secret, channel, rs);
          if (this._destroyed) break;
          const peer = this.peer;
          if (!peer || peer.destroyed) break;
          const call = peer.call(id, live);
          if (call) { this._registerLeg(call, rs, 'live'); report.redialed++; }
        } catch { /* noop */ }
      }
    }
    if (!stale.length && !redialSlots.length && live && secret && channel && this.slot >= 0 && this._seenPeers.size > 0) {
      /* PTT-first-tap zero-leg sweep (mirrors watchdog): a rejoiner with
         faces rediscovers all unlinked non-self slots live; a fresh solo
         with empty seen stays silent instead of spraying empty slots. */
      for (let j = 0; j < this.cfg.maxSlots; j++) {
        if (j === this.slot) continue;
        if ([...this.legs.values()].some((l) => l.slot === j)) continue;
        if (this._destroyed) break;
        if ((this._dialFails.get(j) ?? 0) >= 3) continue; // parked — TX doesn't unpark
        try {
          const id = await slotPeerId(secret, channel, j);
          if (this._destroyed) break;
          const peer = this.peer;
          if (!peer || peer.destroyed) break;
          const call = peer.call(id, live);
          if (call) { this._registerLeg(call, j, 'live'); report.redialed++; }
        } catch { /* noop */ }
      }
    }
    return report;
  }

  _senderFor(pc: RTCPeerConnection | null | undefined): RTCRtpSender | null {
    if (!pc || typeof pc.getSenders !== 'function') return null;
    const senders = pc.getSenders();
    return senders.find((s) => s.track && s.track.kind === 'audio')
      || senders.find((s) => !s.track)
      || null;
  }

  endTx(): void {
    /* legs keep SENDING — now the shared silent TRACK (DTX-idle), so
       the leg stays media-alive and hot-attach works on the next TX */
    const track = getSilentTrack();
    for (const [, leg] of this.legs) {
      leg.recvonly = false;
      if (!track) continue;
      const pc = leg.call.peerConnection as RTCPeerConnection | null | undefined;
      const sender = pc ? this._senderFor(pc) : null;
      if (sender) { try { sender.replaceTrack(track); } catch { /* noop */ } }
    }
    if (!track) this.log('END TX — NO SILENT TRACK — LEGS KEPT AS-IS', 'warn');
    this._drainPendingRedials();
  }

  /* Redials deferred mid-TX by the ICE watch paths. Guarded: only when
     the peer is alive on a claimed slot. */
  private _drainPendingRedials(): void {
    if (!this._pendingRedial.size) return;
    const slots = [...this._pendingRedial];
    this._pendingRedial.clear();
    if (!this.peer || this.peer.destroyed || this.slot < 0 || this._destroyed) return;
    for (const s of slots) {
      const linked = [...this.legs.values()].some((l) => l.slot === s);
      if (!linked) this._dialListen(s);
    }
  }

  /* ── SAS (DTLS fingerprint verification code) ──────────── */
  /* Per-peer prints: SAS is computed over the union of prints
     belonging to CURRENT legs only; a peer's entry is dropped when
     its leg closes/errors. */
  async _collectSas(pc: any, peerId?: string): Promise<void> {
    if (!this.e2ee) return;
    try {
      const stats = await pc.getStats();
      const fresh = new Set<string>();
      stats.forEach((s: { type?: string; fingerprint?: string }) => {
        if (s.type === 'certificate' && s.fingerprint) fresh.add(s.fingerprint);
      });
      if (peerId) {
        const cur = this._sasPrints.get(peerId) ?? new Set<string>();
        for (const f of fresh) cur.add(f);
        this._sasPrints.set(peerId, cur);
      }
      const union = new Set<string>();
      for (const [pid, prints] of this._sasPrints) {
        if (!this.legs.has(pid)) continue;   // stale entry — not a current leg
        for (const f of prints) union.add(f);
      }
      if (!peerId) for (const f of fresh) union.add(f);
      if (union.size >= 2) {
        const code = await sasCode(state.secret ?? '', [...union]);
        set({ sas: code });
      }
    } catch { /* noop */ }
  }

  /* ── WATCHDOG (symmetric, TX-safe) ─────────────────────── */
  _startWatchdog(): void {
    if (this._watchdogTimer != null) clearInterval(this._watchdogTimer);
    this._watchdogTick = 0;

    /* On unhide, retry pre-gesture slots that were skipped. */
    if (typeof document !== 'undefined' && !this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (!document.hidden) this.retryPendingDials();
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    this._watchdogTimer = setInterval(() => {
      if (this._destroyed) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (state.tx) return;                       // never disturb an active TX
      /* Outage hush: with no signaling socket, redials can't learn
         anything — they only burn sockets, spam strikes, and hammer the
         broker. The reconnect chain / rejoin owns recovery until 'open'. */
      if (!state.connected) return;
      if (!this.peer || this.peer.destroyed || this.slot < 0) return;
      /* Slow lane: every 4th sweep retries PARKED slots too, so a
         revived peer rejoins within ~1min without hot-looping. */
      const force = (++this._watchdogTick % 4 === 0);
      if (this.legs.size === 0) {
        /* zero-leg probe: sweep only if we've SEEN peers on this channel
           (rejoin partition, pre-gesture skips). A fresh solo join has an
           empty seen-set — stay silent instead of dialing 7 empty slots
           every 15s. Claim-time dials + unlock/TX redials cover discovery. */
        if (this._seenPeers.size === 0) return;
        for (const slot of this._seenPeers) {
          if (slot === this.slot) continue;
          const linked = [...this.legs.values()].some((l) => l.slot === slot);
          if (!linked) {
            this.log(`WATCHDOG — REDIAL UNIT-${slot}`, 'sys');
            this._dialListen(slot, force);
          }
        }
        return;
      }
      for (const slot of this.knownOccupied) {
        if (slot === this.slot) continue;
        const linked = [...this.legs.values()].some((l) => l.slot === slot);
        if (!linked) {
          this.log(`WATCHDOG — REDIAL UNIT-${slot}`, 'sys');
          this._dialListen(slot, force);
        }
      }
    }, this.cfg.watchdogMs);
  }

  /* ── QUALITY (signal bars) ─────────────────────────────── */
  startQualityPolling(interval: number = this.cfg.statsPollMs): void {
    if (this._statsTimer != null) clearInterval(this._statsTimer);
    this._qualityHistory = [];
    const poll = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!this.peer || !this.legs.size) return;
      let best = 0;
      for (const [, leg] of this.legs) {
        try {
          const st = await leg.call.peerConnection.getStats();
          st.forEach((s: { type?: string; state?: string; currentRoundTripTime?: number }) => {
            if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime != null) {
              const rtt = s.currentRoundTripTime * 1000;
              best = Math.max(best, rtt < 80 ? 4 : rtt < 160 ? 3 : rtt < 300 ? 2 : 1);
            }
          });
        } catch { /* noop */ }
      }
      emitQuality(best);
      this._qualityHistory.push(best);
      if (this._qualityHistory.length > 5) this._qualityHistory.shift();
      const stable = this._qualityHistory.length >= 3 &&
        this._qualityHistory.every((v, i, a) => i === 0 || v === a[i - 1]);
      const nextInterval = stable ? this.cfg.statsPollMs * 2 : this.cfg.statsPollMs;
      this._statsTimer = setTimeout(poll, nextInterval);
    };
    this._statsTimer = setTimeout(poll, interval);
  }

  stopQualityPolling(): void {
    if (this._statsTimer != null) { clearTimeout(this._statsTimer); this._statsTimer = null; }
  }
}

/* lightweight external event sinks (avoid circular imports for UI) */
type QualityListener = (v: number) => void;
const qualityListeners = new Set<QualityListener>();
export function onQuality(fn: QualityListener): void { qualityListeners.add(fn); }
function emitQuality(v: number): void { for (const fn of qualityListeners) fn(v); }

type CryptoListener = (s: string) => void;
const cryptoListeners = new Set<CryptoListener>();
export function onCrypto(fn: CryptoListener): void { cryptoListeners.add(fn); }
function emitCrypto(v: string): void { for (const fn of cryptoListeners) fn(v); }
