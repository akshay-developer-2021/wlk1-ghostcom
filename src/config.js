/* src/config.js — deployment knobs. Override via window.WLK1_CONFIG. */

export const CONFIG = {
  signaling: {
    // Self-host a PeerJS broker for production (see README); the free
    // cloud broker is the default for zero-config personal use.
    host: (typeof window !== 'undefined' && window.WLK1_CONFIG?.signalingHost) || undefined,
    secure: true,
  },
  iceServers: (typeof window !== 'undefined' && window.WLK1_CONFIG?.iceServers) || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    // Public OpenRelay is a best-effort fallback. For production run your
    // own coturn and use short-lived HMAC credentials (see README).
    {
      urls: [
        'turn:standard.openrelay.metered.ca:80',
        'turn:standard.openrelay.metered.ca:443',
        'turn:standard.openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  maxSlots: 8,
  slotProbeTimeoutMs: 4000,
  warmWindowMs: 45_000,
  watchdogMs: 15_000,
  statsPollMs: 15_000,
  maxTxMs: 5 * 60_000,            // safety: TX auto-cutoff after 5 min
  reconnect: { maxTries: 5, baseMs: 500, maxMs: 8000 },
};
