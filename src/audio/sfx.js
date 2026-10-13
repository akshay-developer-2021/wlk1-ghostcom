/* audio/sfx.js — radio sound personality + haptics.
   One lazily-created AudioContext, shared with the UI. The context
   is suspended by the battery module whenever nothing needs it. */

export class Sfx {
  constructor({ AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext, navigatorRef = navigator, log = () => {} } = {}) {
    this._AC = AudioCtx;
    this._nav = navigatorRef;
    this._log = log;
    this.ctx = null;
    /* each radio gets its own voice: fixed per-session pitch drift */
    this.voice = 0.92 + Math.random() * 0.16; // 0.92–1.08 detune
  }

  /** Must be called from a user gesture (first tap anywhere). */
  unlock() {
    if (!this._AC) return;
    if (!this.ctx) this.ctx = new this._AC();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  suspend() { if (this.ctx?.state === 'running') this.ctx.suspend().catch(() => {}); }

  tone(f, d, type = 'square', g = 0.08, detune = true) {
    if (!this.ctx) return;
    try {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      const o = this.ctx.createOscillator();
      const gn = this.ctx.createGain();
      o.type = type;
      o.frequency.value = detune ? f * this.voice : f;
      gn.gain.setValueAtTime(g, this.ctx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + d);
      o.connect(gn); gn.connect(this.ctx.destination);
      o.start(); o.stop(this.ctx.currentTime + d);
    } catch { /* audio is never allowed to break the radio */ }
  }

  squelch(d = 0.12) {
    if (!this.ctx) return;
    try {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      const len = Math.max(1, this.ctx.sampleRate * d) | 0;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const s = this.ctx.createBufferSource(); s.buffer = buf;
      const g = this.ctx.createGain(); g.gain.value = 0.06;
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1200;
      s.connect(f); f.connect(g); g.connect(this.ctx.destination); s.start();
    } catch { /* noop */ }
  }

  /* roger beep — two-note sign-off, detuned per radio = a "voice" */
  roger() {
    this.tone(1150, 0.07, 'square', 0.07);
    setTimeout(() => this.tone(1725, 0.09, 'square', 0.07), 90);
  }

  key = () => this.tone(1200, 0.03, 'square', 0.05);
  pttOpen = () => { this.tone(1400, 0.05, 'square', 0.09); this.squelch(0.1); };
  pttClose = () => { this.squelch(0.14); this.tone(900, 0.04, 'square', 0.07); };
  linkOpen = () => { this.tone(700, 0.06); this.tone(1050, 0.08); };
  linkLost = () => this.tone(500, 0.1, 'sawtooth', 0.06);
  lock = () => this.tone(1600, 0.04, 'square', 0.07);

  haptic(pattern) {
    try { this._nav.vibrate?.(pattern); } catch { /* noop */ }
  }
}

export const HAPTIC = {
  key: 4,
  ptt: 12,
  link: [8, 40, 8],
  rx: 6,
  warn: [30, 60, 30],
};
