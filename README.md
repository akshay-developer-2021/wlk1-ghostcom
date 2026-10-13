# WLK-1 ▮ GHOSTCOM — encrypted P2P field radio (production)

Single-purpose, zero-backend push-to-talk voice radio. Hold the glass
button, talk, release. Rooms are secret-keyed, audio is end-to-end
encrypted, and the microphone hardware is **off** whenever you are not
transmitting.

> Born from the PoC in `legacy/index.html` — rebuilt as a production
> Vite app after a 5-angle audit (security, performance, battery,
> reliability, UX). See "What changed from the PoC" below.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173 (mic needs localhost or HTTPS)
npm test           # vitest unit suite
npm run build      # production bundle → dist/
npm run preview    # serve dist/
```

Deploy `dist/` to **any static host with HTTPS** (Cloudflare Pages,
Netlify, GitHub Pages+proxy, etc.). No server-side code required.

## How it works

```
src/
  core/crypto.js     room secrets → HMAC peer IDs, SAS codes, E2EE key
  core/state.js      tiny reactive store (no framework)
  core/battery.js    battery API, power-save, visibility, wake lock
  audio/mic.js       cold-mic manager + WARM WINDOW + generation tokens
  audio/silentTrack.js  guaranteed audio sender on every leg
  audio/sfx.js       radio sound personality (per-unit roger beep) + haptics
  webrtc/mesh.js     parallel slot claim, secret-verified legs, watchdog
  security/e2ee.js   insertable-streams AES-GCM frame encryption
  ui/*               LCD, PTT controller, VAD-gated render loop, boot theater
```

## Security model (honest version)

- **Credential**: each room has a random secret (Crockford base32,
  80 bits) shared inside the deep link `#22.SECRET`. The 2-digit
  channel is only a display name.
- **Un-enumerable rooms**: peer IDs are `HMAC(secret, slot)` — without
  the secret, an attacker cannot find the room on the signaling broker,
  squat IDs, or even confirm it exists.
- **Authenticated legs**: inbound calls whose peer ID doesn't derive
  from *our* secret for *our* channel are closed ("FOREIGN SIGNAL
  REJECTED").
- **True E2EE**: on browsers supporting WebRTC Encoded Transforms, every
  RTP frame is AES-GCM encrypted with a PBKDF2 key derived from the
  room secret. The broker and TURN relay see ciphertext only.
  **Capability-negotiated**: transforms attach only after the peer
  proves support over a side DataChannel — a peer without support gets
  a plain SRTP leg (never garbage audio), and the LCD badge shows the
  truth: `E2E` (all legs encrypted), `⚠ MIXED SRTP`, or `SRTP`.
- **SAS verification**: a 4-character code derived from the room secret
  + every leg's DTLS fingerprint appears on the LCD. Team members
  compare it out-of-band; a MITM changes it.
- **Cold mic**: hardware is acquired on PTT press only, released after
  a 45s muted warm window (instant next TX; indicator disappears).
  Mic-test path is verified to hard-release.
- **Hardened page**: CSP with no third-party script origins, peerjs is
  bundled from npm (no CDN supply chain), fonts self-hosted, all
  peer-derived text rendered via `textContent` (XSS-safe).

## Battery design

- Mic hardware off unless transmitting (warm window is muted capture).
- Render loop is VAD-gated: 15 fps while someone speaks → 2 Hz poll
  when silent → fully stopped + AudioContext suspended with no peers.
- Wake lock held only during TX. Matrix rain is a 2.5 s boot flourish.
- Watchdog pauses when the tab is hidden; quality polling backs off.
- Power-save mode (<20% battery, discharging) drops everything to 5 fps
  and kills cosmetic animations.

## Production deployment notes

1. **Signaling**: default uses the free PeerJS cloud broker. For real
   use, run your own: `npx peer --port 443 --key key.pem --cert cert.pem`
   and set `window.WLK1_CONFIG = { signalingHost: 'your.broker.host' }`
   before the module bundle (e.g. in `index.html`).
2. **TURN**: the bundled OpenRelay credentials are best-effort. Run
   [coturn](https://github.com/coturn/coturn) and inject short-lived
   HMAC credentials via `window.WLK1_CONFIG.iceServers`.
3. **iOS**: audio unlock happens on the first tap; HTTPS is mandatory
   for `getUserMedia`.

## What changed from the PoC (audit → fix map)

| PoC bug | Fix |
|---|---|
| `micTest()` leaked a hot mic (silent broadcast) | verified path hard-releases; inbound answer requires live TX |
| PTT tap race latched TX without a finger | generation tokens in both PTT controller and mic manager |
| Peer IDs guessable (`wlk1-ch-22-3`) | HMAC-derived IDs + inbound verification |
| "E2E" badge was DTLS-only | insertable-streams AES-GCM + honest badge + SAS |
| Sequential slot scan (join up to 40 s) | parallel claim (~1 s), full-vs-unreachable diagnosis |
| 350–700 ms PTT latency | warm-mic window → ~100 ms re-arm |
| rAF ran forever with peers linked | VAD-gated 15fps→2Hz→sleep ladder |
| Ghost legs from dialing empty slots | `peer-unavailable` cleanup + known-occupied watchdog |
| Broker `disconnected` fallback was a no-op | immediate reconnect + backoff + full rejoin |
| Share link `#ch` never parsed | hash-first session init with secret |
| Keypad dead after joining | rolling dial — type over to change channel |
| PTT pointer-only | keyboard: hold Space/Enter on the focused button |
