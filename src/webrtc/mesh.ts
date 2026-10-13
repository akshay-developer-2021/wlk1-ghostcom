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
import { CONFIG, type AppConfig } from '../config.js';
import { slotPeerId, callerSlot, sasCode } from '../core/crypto.js';
import { set, state, setPeer, removePeer, clearPeers, linkedSlots } from '../core/state.js';
import { silentStream, getSilentTrack } from '../audio/silentTrack.js';
import type { MicManager } from '../audio/mic.js';
import type { Sfx } from '../audio/sfx.js';
import type { E2EE } from '../security/e2ee.js';
import type { LogKind } from '../ui/dom.js';

export interface Leg { call: any /* PeerJS MediaConnection */; slot: number; mode: 'live'|'listen'; crypto: boolean|null; recvonly?: boolean; _cryptoTimer?: any; _misses?: number }

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
  private _joinMutex: Promise<JoinResult | undefined> | null = null;
  private _destroyed = false;
  private _sasPrints = new Set<string>();
  private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private _statsTimer: ReturnType<typeof setInterval> | null = null;
  private _txGen = 0;
  private _dataConns = new Map<string, DataConnection>();      // peerId -> crypto-negotiation DataConnection

  constructor({ sfx = null, mic = null, e2ee = null, log = () => {}, config = CONFIG }: MeshOptions = {}) {
    this.sfx = sfx;
    this.mic = mic;
    this.e2ee = e2ee;
    this.log = log;
    this.cfg = config;
  }

  get linked(): number[] { return linkedSlots(); }

  /* ── JOIN ──────────────────────────────────────────────── */
  async join(channel: string): Promise<JoinResult | undefined> {
    if (this._joinMutex) return this._joinMutex;
    if (this.peer && this.channel === channel) return undefined;
    this._joinMutex = this._join(channel).finally(() => { this._joinMutex = null; });
    return this._joinMutex;
  }

  async _join(channel: string): Promise<JoinResult> {
    this.leave();
    set({ joined: false, connected: false });
    this.channel = channel;
    this.log(`SCANNING CH ${channel}…`, 'sys');

    const secret = state.secret;
    if (!secret) {
      this.log('NO SECRET — JOIN ABORTED', 'warn');
      set({ joined: false });
      return { ok: false, reason: 'no-secret' };
    }

    /* PARALLEL slot claim: race all slots at once, first open wins. */
    let sawUnavailable = false, sawNetworkError = false;
    interface SlotAttempt { slot: number; peer?: Peer; result: string }
    const attempts: Array<Promise<SlotAttempt>> = [];
    for (let i = 0; i < this.cfg.maxSlots; i++) {
      attempts.push((async (): Promise<SlotAttempt> => {
        const id = await slotPeerId(secret, channel, i);
        let p: Peer;
        try {
          p = new Peer(id, {
            config: { iceServers: this.cfg.iceServers },
            debug: 0 as LogLevel,
            ...(this.cfg.signaling.host
              ? { host: this.cfg.signaling.host, secure: this.cfg.signaling.secure }
              : {}),
          });
        } catch { return { slot: i, result: 'error' }; }
        const result: string = await new Promise<string>((res) => {
          const t = setTimeout(() => res('timeout'), this.cfg.slotProbeTimeoutMs);
          p.on('open', () => { clearTimeout(t); res('open'); });
          p.on('error', (e) => {
            clearTimeout(t);
            const type = e.type || 'error';
            if (type === 'unavailable-id') sawUnavailable = true;
            if (['network', 'server-error', 'socket-error'].includes(type)) sawNetworkError = true;
            res(type);
          });
        });
        return { slot: i, peer: p, result };
      })());
    }

    const results = await Promise.all(attempts);
    const winner = results.find((r) => r.result === 'open' && r.peer);
    for (const r of results) {                    // destroy losers immediately
      if (r !== winner && r.peer) { try { r.peer.destroy(); } catch { /* noop */ } }
    }

    if (!winner || !winner.peer) {
      const reason = sawUnavailable && !sawNetworkError ? 'full' : 'unreachable';
      this.log(reason === 'full'
        ? `CH ${channel} FULL — ALL ${this.cfg.maxSlots} SLOTS`
        : 'SIGNAL UNREACHABLE', 'warn');
      set({ joined: false });
      return { ok: false, reason };
    }

    this.peer = winner.peer;
    this.slot = winner.slot;
    set({ mySlot: winner.slot, joined: true, connected: true });
    this.knownOccupied.clear();
    this._wirePeer(this.peer);
    this.log(`SLOT ${this.slot} CLAIMED — CH ${channel}`, 'sys');
    for (let j = 0; j < this.slot; j++) this._dialListen(j);
    this.sfx?.linkOpen();
    this._startWatchdog();
    return { ok: true, slot: this.slot };
  }

  leave(keepFlag = false): void {
    if (!keepFlag) this._destroyed = false;
    if (this._watchdogTimer != null) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    if (this._statsTimer != null) { clearInterval(this._statsTimer); this._statsTimer = null; }
    for (const [, leg] of this.legs) { try { leg.call.close(); } catch { /* noop */ } }
    this.legs.clear();
    for (const [, conn] of this._dataConns) { try { conn.close(); } catch { /* noop */ } }
    this._dataConns.clear();
    this._pendingRedial.clear();
    this._missStrikes.clear();
    clearPeers();
    if (this.peer) { try { this.peer.destroy(); } catch { /* noop */ } this.peer = null; }
    this.slot = -1;
    this.knownOccupied.clear();
    this._sasPrints.clear();
    set({ mySlot: -1, joined: false, connected: false, sas: null });
  }

  destroy(): void { this._destroyed = true; this.leave(true); }

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
        const id = m?.[1];
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

    /* Real broker-outage recovery (the PoC swallowed this). */
    p.on('disconnected', () => {
      if (this._destroyed || this.peer !== p) return;
      set({ connected: false });
      this.log('SIGNAL LOST — RECONNECTING…', 'warn');
      let tries = 0;
      const retry = (): void => {
        if (this._destroyed || !this.peer || this.peer !== p) return;
        try { p.reconnect(); } catch { /* noop */ }
        this.log(`RECONNECT TRY ${++tries}`, 'sys');
        if (tries < this.cfg.reconnect.maxTries) {
          setTimeout(retry, Math.min(this.cfg.reconnect.baseMs * 2 ** tries, this.cfg.reconnect.maxMs));
        } else {
          this._rejoin();
        }
      };
      retry();                                    // reconnect immediately, no dead 1.2s
    });

    p.on('open', () => set({ connected: true }));
  }

  async _rejoin(): Promise<void> {
    if (this._destroyed) return;
    const ch = this.channel;
    this.leave();
    if (ch) await this.join(ch);
  }

  /* ── LEGS ──────────────────────────────────────────────── */
  _dialListen(slot: number): void {
    if (!this.peer || this.slot < 0) return;
    const secret = state.secret;
    const channel = this.channel;
    if (!secret || !channel) return;
    slotPeerId(secret, channel, slot).then((id) => {
      const peer = this.peer;
      if (!peer || peer.destroyed) return;
      if (this.legs.has(id)) return;
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
        return;
      }
      if (!call) { this.log(`DIAL UNIT-${slot} FAILED — NO CALL`, 'warn'); return; }
      this._registerLeg(call, slot, 'listen');
      this.log(`LISTEN LEG → UNIT-${slot}`, 'rx');
    }).catch(() => {});
  }

  /* Re-attempt lower-slot dials that were skipped for lack of an audio
     sender (pre-gesture Safari). Safe to call on every unlock. */
  retryPendingDials(): void {
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
      const sil = liveMic ? null : silentStream();
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
      const leg = this._registerLeg(call, slot, liveMic ? 'live' : 'listen');
      if (recvonly) leg.recvonly = true;
      this.log(`LINK ESTABLISHED — UNIT-${slot}`, 'rx');
      this.sfx?.linkOpen();
      this.sfx?.haptic?.([8, 40, 8]);
    }).catch(() => {
      try { call.close(); } catch { /* noop */ }
    });
  }

  _registerLeg(call: any, slot: number, mode: 'live' | 'listen'): Leg {
    const id = call.peer as string;
    const leg: Leg = { call, slot, mode, crypto: null };   // null=pending handshake
    this.legs.set(id, leg);
    this.knownOccupied.add(slot);
    setPeer(slot, { linked: true });
    call.on('stream', (remote: MediaStream) => this._onRemoteStream(slot, remote));
    call.on('close', () => {
      if (this.legs.get(id)?.call !== call) return;   // stale event from a replaced leg — no cross-kill
      clearTimeout(leg._cryptoTimer);
      this.legs.delete(id);
      removePeer(slot);
      this.log(`LINK DROPPED — UNIT-${slot}`, 'warn');
      this.sfx?.linkLost();
      this._emitCrypto();
    });
    call.on('error', () => {
      if (this.legs.get(id)?.call !== call) return;   // stale event from a replaced leg — no cross-kill
      clearTimeout(leg._cryptoTimer);
      this.legs.delete(id);
      removePeer(slot);
      this._emitCrypto();
    });
    this._watchIce(call, slot);
    this._wireSas(call);
    this._negotiateCrypto(call, leg);
    this._emitCrypto();
    return leg;
  }

  /* ── E2EE CAPABILITY NEGOTIATION ─────────────────────────
     Frames are encrypted ONLY after the peer proves support over
     a side DataChannel. A peer without Encoded Transforms gets a
     plain SRTP leg instead of garbage audio. Badge reflects truth:
     e2ee = every leg confirmed; mixed = some legs plain. */
  _negotiateCrypto(call: any, leg: Leg): void {
    leg._cryptoTimer = setTimeout(() => this._settleCrypto(leg, false, 'handshake timeout'), 3000);
    let conn: DataConnection | undefined = this._dataConns.get(call.peer);
    if (!conn && this.peer && !this.peer.destroyed) {
      try {
        const dc = this.peer.connect(call.peer, { serialization: 'json', reliable: true });
        if (dc) { this._dataConns.set(call.peer, dc); conn = dc; }
      } catch { conn = undefined; }
    }
    if (conn) this._wireCryptoConn(conn, leg);
    else this._settleCrypto(leg, false, 'no data channel');
  }

  _wireCryptoConn(conn: DataConnection, leg: Leg): void {
    conn.on('open', () => { try { conn.send({ t: 'wlk1-hello', e2ee: !!this.e2ee }); } catch { /* noop */ } });
    conn.on('data', (d: unknown) => {
      const m = (d ?? null) as { t?: unknown; e2ee?: unknown; speaking?: unknown } | null;
      if (!m || typeof m.t !== 'string') return;
      /* presence heartbeat — remote PTT state, independent of crypto */
      if (m.t === 'wlk1-speaking') {
        if (this.legs.get(conn.peer) === leg) setPeer(leg.slot, { speaking: !!m.speaking });
        return;
      }
      if (m.t !== 'wlk1-hello' && m.t !== 'wlk1-ack') return;
      if (m.t === 'wlk1-hello') { try { conn.send({ t: 'wlk1-ack', e2ee: !!this.e2ee }); } catch { /* noop */ } }
      this._settleCrypto(leg, !!m.e2ee, m.e2ee ? '' : 'peer lacks transforms');
    });
    conn.on('close', () => { if (this._dataConns.get(conn.peer) === conn) this._dataConns.delete(conn.peer); });
    conn.on('error', () => { /* media leg has its own error path */ });
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

  /* inbound DataChannel from a peer that initiated negotiation */
  _onDataConn(conn: DataConnection): void {
    const leg = this.legs.get(conn.peer);
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
      if (!this.legs.has(conn.peer)) {
        try { conn.close(); } catch { /* noop */ }
        if (this._dataConns.get(conn.peer) === conn) this._dataConns.delete(conn.peer);
      }
    }, 6000);
  }

  _settleCrypto(leg: Leg, remoteCapable: boolean, why = ''): void {
    if (!leg || !this.legs.has(leg.call.peer)) { this._emitCrypto(); return; }
    clearTimeout(leg._cryptoTimer);
    const e2ee = this.e2ee;
    const capable = remoteCapable && !!e2ee;
    if (leg.crypto !== capable) {
      leg.crypto = capable;
      if (capable && e2ee) {
        const pc = leg.call.peerConnection as RTCPeerConnection | null | undefined;
        if (pc) {
          this._armE2ee(pc, e2ee, leg.slot);
        } else {
          /* peerConnection not exposed yet (glare/renegotiation race) —
             poll briefly before downgrading the leg to SRTP. */
          let tries = 0;
          const poll = (): void => {
            if (!this.legs.has(leg.call.peer)) return;
            const p = leg.call.peerConnection as RTCPeerConnection | null | undefined;
            if (p) {
              this._armE2ee(p, e2ee, leg.slot);
              this._emitCrypto();
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
          setTimeout(poll, 250);
        }
      } else {
        this.log(`UNIT-${leg.slot} — E2EE UNAVAILABLE (${why}) — SRTP LEG`, 'warn');
      }
    }
    this._emitCrypto();
  }

  private _armE2ee(pc: RTCPeerConnection, e2ee: E2EE, slot: number): void {
    const s = this._senderFor(pc);
    if (s) e2ee.secureSender(s).catch(() => {});
    for (const r of pc.getReceivers()) e2ee.secureReceiver(r).catch(() => {});
    pc.addEventListener('track', (ev) => { e2ee.secureReceiver(ev.receiver).catch(() => {}); });
    this.log(`UNIT-${slot} — E2EE AES-GCM ARMED`, 'sys');
  }

  _emitCrypto(): void {
    const legs = [...this.legs.values()];
    let status: string;
    if (!this.e2ee) status = 'srtp-only';
    else if (!legs.length) status = 'ready';
    else if (legs.every((l) => l.crypto === true)) status = 'e2ee';
    else if (legs.some((l) => l.crypto === false)) status = 'mixed';
    else status = 'pending';
    emitCrypto(status);
  }

  /* SAS collection runs regardless of capability (fingerprint truth) */
  _wireSas(call: any): void {
    if (!this.e2ee) return;
    const attach = (): void => {
      const pc = call.peerConnection as RTCPeerConnection | null | undefined;
      if (!pc) { setTimeout(attach, 100); return; }
      pc.addEventListener('iceconnectionstatechange', () => this._collectSas(pc));
    };
    attach();
  }

  _onRemoteStream(slot: number, stream: MediaStream): void {
    setPeer(slot, { stream });
    this._missStrikes.delete(slot);   // media is proof of life — reset ghost strikes
    this.log(`RX STREAM — UNIT-${slot}`, 'rx');
  }

  /* ── ICE ───────────────────────────────────────────────── */
  _watchIce(call: any, slot: number): void {
    const attach = (): void => {
      const pc = call.peerConnection as RTCPeerConnection | null | undefined;
      if (!pc) { setTimeout(attach, 100); return; }
      pc.addEventListener('connectionstatechange', () => {
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
              const cur = pc.connectionState;
              if ((cur === 'disconnected' || cur === 'failed') && this.legs.has(call.peer)) {
                if (state.tx) {
                  /* mid-TX: never disturb the air — defer until endTx drains it */
                  this._pendingRedial.add(slot);
                  this.log(`ICE STUCK (${cur}) — REDIAL UNIT-${slot} DEFERRED UNTIL TX END`, 'warn');
                } else {
                  this.log(`ICE STUCK (${cur}) — REDIAL UNIT-${slot}`, 'warn');
                  try { call.close(); } catch { /* noop */ }
                  this.legs.delete(call.peer);
                  removePeer(slot);
                  setTimeout(() => this._dialListen(slot), 1500);
                }
              }
            } catch { /* noop */ }
          }, 5000);
        } else if (st === 'failed' || st === 'closed') {
          clearTimeout(call.__wlkDiscTimer);
          try { call.close(); } catch { /* noop */ }
          this.legs.delete(call.peer);
          removePeer(slot);
          if (state.tx) {
            this._pendingRedial.add(slot);
            this.log(`ICE FAILED — REDIAL UNIT-${slot} DEFERRED UNTIL TX END`, 'warn');
          } else {
            this.log(`ICE FAILED — REDIAL UNIT-${slot}`, 'warn');
            setTimeout(() => this._dialListen(slot), 1500);
          }
        } else if (st === 'connected' || (st as string) === 'completed') {
          clearTimeout(call.__wlkDiscTimer);
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
          /* encrypt only on legs whose peer proved E2EE capability */
          const cur = this.legs.get(id);
          if (cur?.crypto === true && this.e2ee) this.e2ee.secureSender(sender).catch(() => {});
        } catch {
          this.log(`TX ATTACH UNIT-${leg.slot} FAILED — QUEUED FOR REDIAL`, 'warn');
          try { leg.call.close(); } catch { /* noop */ }
          this.legs.delete(id);
          removePeer(leg.slot);
          redialSlots.push(leg.slot);
        }
      } else {
        /* leg with no audio sender — redial it with the live stream */
        try { leg.call.close(); } catch { /* noop */ }
        this.legs.delete(id);
        removePeer(leg.slot);
        redialSlots.push(leg.slot);
      }
    }
    const secret = state.secret;
    const channel = this.channel;
    const live = this.mic?.stream ?? null;
    if (redialSlots.length && secret && channel && live) {
      for (const rs of redialSlots) {
        try {
          const id = await slotPeerId(secret, channel, rs);
          const peer = this.peer;
          if (!peer || peer.destroyed) break;
          const call = peer.call(id, live);
          if (call) { this._registerLeg(call, rs, 'live'); report.redialed++; }
        } catch { /* noop */ }
      }
    }
    if (!stale.length && !redialSlots.length && live && this.slot > 0 && secret && channel) {
      /* PTT-first-tap: joined but holding no legs yet (every dial was
         skipped pre-gesture) — dial all lower slots directly with the
         live mic stream. */
      for (let j = 0; j < this.slot; j++) {
        try {
          const id = await slotPeerId(secret, channel, j);
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
  async _collectSas(pc: any): Promise<void> {
    if (!this.e2ee) return;
    try {
      const stats = await pc.getStats();
      stats.forEach((s: { type?: string; fingerprint?: string }) => {
        if (s.type === 'certificate' && s.fingerprint) this._sasPrints.add(s.fingerprint);
      });
      if (this._sasPrints.size >= 2) {
        const code = await sasCode(state.secret ?? '', [...this._sasPrints]);
        set({ sas: code });
      }
    } catch { /* noop */ }
  }

  /* ── WATCHDOG (symmetric, TX-safe) ─────────────────────── */
  _startWatchdog(): void {
    if (this._watchdogTimer != null) clearInterval(this._watchdogTimer);
    this._watchdogTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (state.tx) return;                       // never disturb an active TX
      for (const slot of this.knownOccupied) {
        if (slot === this.slot) continue;
        const linked = [...this.legs.values()].some((l) => l.slot === slot);
        if (!linked) {
          this.log(`WATCHDOG — REDIAL UNIT-${slot}`, 'sys');
          this._dialListen(slot);
        }
      }
    }, this.cfg.watchdogMs);
  }

  /* ── QUALITY (signal bars) ─────────────────────────────── */
  startQualityPolling(interval: number = this.cfg.statsPollMs): void {
    if (this._statsTimer != null) clearInterval(this._statsTimer);
    this._statsTimer = setInterval(async () => {
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
    }, interval);
  }

  stopQualityPolling(): void {
    if (this._statsTimer != null) { clearInterval(this._statsTimer); this._statsTimer = null; }
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
