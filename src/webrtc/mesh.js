/* ═══════════════════════════════════════════════════════════════
   webrtc/mesh.js — the radio mesh. Rewritten production core.

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

import { Peer } from 'peerjs';
import { CONFIG } from '../config.js';
import { slotPeerId, callerSlot, sasCode } from '../core/crypto.js';
import { set, state, setPeer, removePeer, clearPeers, linkedSlots } from '../core/state.js';
import { silentStream } from '../audio/silentTrack.js';

export class Mesh {
  constructor({ sfx, mic, e2ee = null, log = () => {}, config = CONFIG } = {}) {
    this.sfx = sfx;
    this.mic = mic;
    this.e2ee = e2ee;
    this.log = log;
    this.cfg = config;
    this.peer = null;
    this.channel = null;
    this.slot = -1;
    this.legs = new Map();            // peerId -> {call, slot, mode}
    this.knownOccupied = new Set();   // slots confirmed occupied (ever linked)
    this._joinMutex = null;
    this._destroyed = false;
    this._sasPrints = new Set();
    this._watchdogTimer = null;
    this._statsTimer = null;
    this._txGen = 0;
    this._dataConns = new Map();      // peerId -> crypto-negotiation DataConnection
  }

  get linked() { return linkedSlots(); }

  /* ── JOIN ──────────────────────────────────────────────── */
  async join(channel) {
    if (this._joinMutex) return this._joinMutex;
    if (this.peer && this.channel === channel) return;
    this._joinMutex = this._join(channel).finally(() => { this._joinMutex = null; });
    return this._joinMutex;
  }

  async _join(channel) {
    this.leave();
    set({ joined: false, connected: false });
    this.channel = channel;
    this.log(`SCANNING CH ${channel}…`, 'sys');

    /* PARALLEL slot claim: race all slots at once, first open wins. */
    let sawUnavailable = false, sawNetworkError = false;
    const attempts = [];
    for (let i = 0; i < this.cfg.maxSlots; i++) {
      attempts.push((async () => {
        const id = await slotPeerId(state.secret, channel, i);
        let p;
        try {
          p = new Peer(id, {
            config: { iceServers: this.cfg.iceServers },
            debug: 0,
            ...(this.cfg.signaling.host
              ? { host: this.cfg.signaling.host, secure: this.cfg.signaling.secure }
              : {}),
          });
        } catch { return { slot: i, result: 'error' }; }
        const result = await new Promise((res) => {
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
    const winner = results.find((r) => r.result === 'open');
    for (const r of results) {                    // destroy losers immediately
      if (r !== winner && r.peer) { try { r.peer.destroy(); } catch { /* noop */ } }
    }

    if (!winner) {
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

  leave(keepFlag = false) {
    if (!keepFlag) this._destroyed = false;
    clearInterval(this._watchdogTimer);
    clearInterval(this._statsTimer);
    for (const [, leg] of this.legs) { try { leg.call.close(); } catch { /* noop */ } }
    this.legs.clear();
    for (const [, conn] of this._dataConns) { try { conn.close(); } catch { /* noop */ } }
    this._dataConns.clear();
    clearPeers();
    if (this.peer) { try { this.peer.destroy(); } catch { /* noop */ } this.peer = null; }
    this.slot = -1;
    this.knownOccupied.clear();
    this._sasPrints.clear();
    set({ mySlot: -1, joined: false, connected: false, sas: null });
  }

  destroy() { this._destroyed = true; this.leave(true); }

  /* ── SIGNALING WIRING ──────────────────────────────────── */
  _wirePeer(p) {
    p.on('call', (call) => this._onInbound(call));
    p.on('connection', (conn) => this._onDataConn(conn));

    p.on('error', (e) => {
      const type = e.type || 'error';
      if (type === 'peer-unavailable') {
        /* ghost-leg cleanup: the dialed slot is EMPTY — kill the dead leg */
        const m = /peer ([\w-]+)/.exec(e.message || '');
        const id = m?.[1];
        if (id && this.legs.has(id)) {
          const leg = this.legs.get(id);
          this.legs.delete(id);
          removePeer(leg.slot);
          this.knownOccupied.delete(leg.slot);
          this.log(`UNIT-${leg.slot} NOT ON NET — LEG CLOSED`, 'warn');
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
      const retry = () => {
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

  async _rejoin() {
    if (this._destroyed) return;
    const ch = this.channel;
    this.leave();
    if (ch) await this.join(ch);
  }

  /* ── LEGS ──────────────────────────────────────────────── */
  _dialListen(slot) {
    if (!this.peer || this.slot < 0) return;
    slotPeerId(state.secret, this.channel, slot).then((id) => {
      if (!this.peer || this.peer.destroyed) return;
      if (this.legs.has(id)) return;
      const stream = silentStream();
      const tracks = typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
      if (!stream || tracks.length === 0) {
        // No sender available (AudioContext locked pre-gesture on Safari).
        // Skip — watchdog / unlock handler retries after first tap.
        this.log(`UNIT-${slot} — AUDIO NOT READY, RETRY ON TAP`, 'warn');
        return;
      }
      let call = null;
      try {
        call = this.peer.call(id, stream); // guaranteed audio m-line
      } catch (err) {
        this.log(`DIAL UNIT-${slot} FAILED — ${err.message || err}`, 'warn');
        return;
      }
      if (!call) { this.log(`DIAL UNIT-${slot} FAILED — NO CALL`, 'warn'); return; }
      this._registerLeg(call, slot, 'listen');
      this.log(`LISTEN LEG → UNIT-${slot}`, 'rx');
    }).catch(() => {});
  }

  /* Re-attempt lower-slot dials that were skipped for lack of an audio
     sender (pre-gesture Safari). Safe to call on every unlock. */
  retryPendingDials() {
    if (!this.peer || this.slot < 0 || state.tx) return;
    for (let j = 0; j < this.slot; j++) {
      const has = [...this.legs.values()].some((l) => l.slot === j);
      if (!has) this._dialListen(j);
    }
  }

  _onInbound(call) {
    if (!this.peer) { try { call.close(); } catch { /* noop */ } return; }
    /* SECURITY: only calls whose ID is a valid secret-derived slot
       for OUR channel are answered. Everything else is dropped. */
    callerSlot(state.secret, this.channel, call.peer, this.cfg.maxSlots).then((slot) => {
      if (slot < 0 || slot === this.slot) {
        this.log('FOREIGN SIGNAL REJECTED', 'warn');
        try { call.close(); } catch { /* noop */ }
        return;
      }
      /* Answer with the live mic ONLY while actually transmitting;
         otherwise the silent track (muted-mic leak fix). If the silent
         context is still locked (pre-gesture Safari), answer recvonly
         rather than offering a trackless m-line that breaks negotiation. */
      const txLive = state.tx && this.mic.hot && this.mic.stream;
      const sil = txLive ? null : silentStream();
      const silTracks = typeof sil?.getAudioTracks === 'function' ? sil.getAudioTracks() : [];
      try {
        if (txLive) call.answer(this.mic.stream);
        else if (sil && silTracks.length) call.answer(sil);
        else call.answer();
      } catch (err) {
        this.log(`ANSWER UNIT-${slot} FAILED — ${err.message || err}`, 'warn');
        try { call.close(); } catch { /* noop */ }
        return;
      }
      this._registerLeg(call, slot, txLive ? 'live' : 'listen');
      this.log(`LINK ESTABLISHED — UNIT-${slot}`, 'rx');
      this.sfx?.linkOpen();
      this.sfx?.haptic?.([8, 40, 8]);
    }).catch(() => {
      try { call.close(); } catch { /* noop */ }
    });
  }

  _registerLeg(call, slot, mode) {
    const id = call.peer;
    const leg = { call, slot, mode, crypto: null };   // null=pending handshake
    this.legs.set(id, leg);
    this.knownOccupied.add(slot);
    setPeer(slot, { linked: true });
    call.on('stream', (remote) => this._onRemoteStream(slot, remote));
    call.on('close', () => {
      clearTimeout(leg._cryptoTimer);
      this.legs.delete(id);
      removePeer(slot);
      this.log(`LINK DROPPED — UNIT-${slot}`, 'warn');
      this.sfx?.linkLost();
      this._emitCrypto();
    });
    call.on('error', () => { this.legs.delete(id); removePeer(slot); this._emitCrypto(); });
    this._watchIce(call, slot);
    this._wireSas(call);
    this._negotiateCrypto(call, leg);
    this._emitCrypto();
  }

  /* ── E2EE CAPABILITY NEGOTIATION ─────────────────────────
     Frames are encrypted ONLY after the peer proves support over
     a side DataChannel. A peer without Encoded Transforms gets a
     plain SRTP leg instead of garbage audio. Badge reflects truth:
     e2ee = every leg confirmed; mixed = some legs plain. */
  _negotiateCrypto(call, leg) {
    leg._cryptoTimer = setTimeout(() => this._settleCrypto(leg, false, 'handshake timeout'), 3000);
    let conn = this._dataConns.get(call.peer);
    if (!conn) {
      try {
        conn = this.peer.connect(call.peer, { serialization: 'json', reliable: true });
        if (conn) this._dataConns.set(call.peer, conn);
      } catch { conn = null; }
    }
    if (conn) this._wireCryptoConn(conn, leg);
    else this._settleCrypto(leg, false, 'no data channel');
  }

  _wireCryptoConn(conn, leg) {
    conn.on('open', () => { try { conn.send({ t: 'wlk1-hello', e2ee: !!this.e2ee }); } catch { /* noop */ } });
    conn.on('data', (d) => {
      if (!d || (d.t !== 'wlk1-hello' && d.t !== 'wlk1-ack')) return;
      if (d.t === 'wlk1-hello') { try { conn.send({ t: 'wlk1-ack', e2ee: !!this.e2ee }); } catch { /* noop */ } }
      this._settleCrypto(leg, !!d.e2ee);
    });
    conn.on('close', () => this._dataConns.delete(conn.peer));
    conn.on('error', () => { /* media leg has its own error path */ });
  }

  /* inbound DataChannel from a peer that initiated negotiation */
  _onDataConn(conn) {
    const leg = this.legs.get(conn.peer);
    this._dataConns.set(conn.peer, conn);
    if (leg) this._wireCryptoConn(conn, leg);
    else conn.on('open', () => conn.close?.());          // unknown peer — drop
  }

  _settleCrypto(leg, remoteCapable, why = '') {
    if (!leg || !this.legs.has(leg.call.peer)) { this._emitCrypto(); return; }
    clearTimeout(leg._cryptoTimer);
    const capable = remoteCapable && !!this.e2ee;
    if (leg.crypto !== capable) {
      leg.crypto = capable;
      if (capable) {
        const pc = leg.call.peerConnection;
        if (pc) {
          const s = this._senderFor(pc);
          if (s) this.e2ee.secureSender(s).catch(() => {});
          for (const r of pc.getReceivers()) this.e2ee.secureReceiver(r).catch(() => {});
          pc.addEventListener('track', (ev) => this.e2ee.secureReceiver(ev.receiver).catch(() => {}));
        }
        this.log(`UNIT-${leg.slot} — E2EE AES-GCM ARMED`, 'sys');
      } else {
        this.log(`UNIT-${leg.slot} — E2EE UNAVAILABLE (${why}) — SRTP LEG`, 'warn');
      }
    }
    this._emitCrypto();
  }

  _emitCrypto() {
    const legs = [...this.legs.values()];
    let status;
    if (!this.e2ee) status = 'srtp-only';
    else if (!legs.length) status = 'ready';
    else if (legs.every((l) => l.crypto === true)) status = 'e2ee';
    else if (legs.some((l) => l.crypto === false)) status = 'mixed';
    else status = 'pending';
    emitCrypto(status);
  }

  /* SAS collection runs regardless of capability (fingerprint truth) */
  _wireSas(call) {
    if (!this.e2ee) return;
    const attach = () => {
      const pc = call.peerConnection;
      if (!pc) { setTimeout(attach, 100); return; }
      pc.addEventListener('iceconnectionstatechange', () => this._collectSas(pc));
    };
    attach();
  }

  _onRemoteStream(slot, stream) {
    setPeer(slot, { stream });
    this.log(`RX STREAM — UNIT-${slot}`, 'rx');
  }

  /* ── ICE ───────────────────────────────────────────────── */
  _watchIce(call, slot) {
    const attach = () => {
      const pc = call.peerConnection;
      if (!pc) { setTimeout(attach, 100); return; }
      pc.addEventListener('connectionstatechange', () => {
        const st = pc.connectionState;
        if (st === 'disconnected') {
          /* transient — try ICE restart first (sub-second recovery).
             Safari often sticks in disconnected instead of failing, so
             schedule a TX-safe redial if it never recovers. */
          this.log(`ICE BLIP — RESTARTING UNIT-${slot}`, 'warn');
          try { pc.restartIce?.(); } catch { /* noop */ }
          clearTimeout(call.__wlkDiscTimer);
          call.__wlkDiscTimer = setTimeout(() => {
            try {
              const cur = pc.connectionState;
              if ((cur === 'disconnected' || cur === 'failed') && this.legs.has(call.peer) && !state.tx) {
                this.log(`ICE STUCK (${cur}) — REDIAL UNIT-${slot}`, 'warn');
                try { call.close(); } catch { /* noop */ }
                this.legs.delete(call.peer);
                removePeer(slot);
                setTimeout(() => this._dialListen(slot), 1500);
              }
            } catch { /* noop */ }
          }, 5000);
        } else if (st === 'failed' || st === 'closed') {
          clearTimeout(call.__wlkDiscTimer);
          this.log(`ICE FAILED — REDIAL UNIT-${slot}`, 'warn');
          try { call.close(); } catch { /* noop */ }
          this.legs.delete(call.peer);
          removePeer(slot);
          if (!state.tx) setTimeout(() => this._dialListen(slot), 1500);
        } else if (st === 'connected' || st === 'completed') {
          clearTimeout(call.__wlkDiscTimer);
        }
      });
    };
    attach();
  }

  /* ── TX ────────────────────────────────────────────────── */
  /** Attach a live mic track to every leg. Returns delivery report. */
  async beginTx(track) {
    const report = { attached: 0, redialed: 0 };
    const stale = [...this.legs.entries()];
    for (const [id, leg] of stale) {
      const pc = leg.call.peerConnection;
      const sender = pc ? this._senderFor(pc) : null;
      if (sender) {
        try {
          await sender.replaceTrack(track);
          report.attached++;
          /* encrypt only on legs whose peer proved E2EE capability */
          const leg = this.legs.get(id);
          if (leg?.crypto === true && this.e2ee) this.e2ee.secureSender(sender).catch(() => {});
        } catch { /* fall through to redial */ }
      } else {
        /* leg with no audio sender — redial it with the live stream */
        try { leg.call.close(); } catch { /* noop */ }
        this.legs.delete(id);
        removePeer(leg.slot);
      }
    }
    if (report.attached === 0 && stale.length) {
      /* nothing attached at all → re-dial known slots with live mic */
      for (const [, leg] of stale) {
        try {
          const id = await slotPeerId(state.secret, this.channel, leg.slot);
          const call = this.peer.call(id, this.mic.stream);
          if (call) { this._registerLeg(call, leg.slot, 'live'); report.redialed++; }
        } catch { /* noop */ }
      }
    }
    return report;
  }

  _senderFor(pc) {
    if (!pc) return null;
    const senders = pc.getSenders();
    return senders.find((s) => s.track && s.track.kind === 'audio')
      || senders.find((s) => !s.track)
      || null;
  }

  endTx() {
    /* legs keep SENDING — now the shared silent track (DTX-idle), so
       the leg stays media-alive and hot-attach works on the next TX */
    const sil = silentStream();
    for (const [, leg] of this.legs) {
      const sender = leg.call.peerConnection && this._senderFor(leg.call.peerConnection);
      if (sender) { try { sender.replaceTrack(sil || null); } catch { /* noop */ } }
    }
  }

  /* ── SAS (DTLS fingerprint verification code) ──────────── */
  async _collectSas(pc) {
    if (!this.e2ee) return;
    try {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'certificate' && s.fingerprint) this._sasPrints.add(s.fingerprint);
      });
      if (this._sasPrints.size >= 2) {
        const code = await sasCode(state.secret, [...this._sasPrints]);
        set({ sas: code });
      }
    } catch { /* noop */ }
  }

  /* ── WATCHDOG (symmetric, TX-safe) ─────────────────────── */
  _startWatchdog() {
    clearInterval(this._watchdogTimer);
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
  startQualityPolling(interval = this.cfg.statsPollMs) {
    clearInterval(this._statsTimer);
    this._statsTimer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!this.peer || !this.legs.size) return;
      let best = 0;
      for (const [, leg] of this.legs) {
        try {
          const st = await leg.call.peerConnection.getStats();
          st.forEach((s) => {
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

  stopQualityPolling() { clearInterval(this._statsTimer); }
}

/* lightweight external event sinks (avoid circular imports for UI) */
const qualityListeners = new Set();
export function onQuality(fn) { qualityListeners.add(fn); }
function emitQuality(v) { for (const fn of qualityListeners) fn(v); }

const cryptoListeners = new Set();
export function onCrypto(fn) { cryptoListeners.add(fn); }
function emitCrypto(v) { for (const fn of cryptoListeners) fn(v); }
