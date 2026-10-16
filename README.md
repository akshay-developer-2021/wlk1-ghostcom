# WLK-1 ▮ GHOSTCOM — encrypted P2P field radio (production)

Single-purpose, zero-backend push-to-talk voice radio. Hold the glass
button, talk, release. Rooms are secret-keyed, audio is end-to-end
encrypted, and the microphone hardware is released as soon as you stop
transmitting.

> Rebuilt as a layered Vite app after a 5-angle audit (security,
> performance, battery, reliability, UX).

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173 (mic needs localhost or HTTPS)
npm test           # vitest unit suite (138 tests)
npm run typecheck  # tsc --noEmit (strict)
npm run build      # production bundle → dist/
npm run preview    # serve dist/ (e2e webServer target)
npm run test:e2e     # playwright, chromium (default)
npm run test:e2e:all # full matrix: chromium + webkit + firefox
                       # needs: npx playwright install --with-deps chromium firefox webkit
```

### Test coverage and known gaps

| Suite | Command | Status |
|---|---|---|
| types | `npm run typecheck` | strict, clean |
| units | `npm test` | 138 tests |
| end-to-end | `npm run test:e2e` | **enforced** — chromium, 12 journeys |
| batch 1:1 | `npm run test:e2e:batch` | N two-process sessions |
| webkit | `npm run test:e2e:webkit` | **enforced** — 7/7 active journeys (two engine-limit skips) |
| firefox | `npm run test:e2e:firefox` | advisory `continue-on-error` lane in CI; see below |

> The e2e suite asserts the E2EE worker discarded **zero** frames after a
> tone round trip. On the headless Chromium used here that check passes
> vacuously — Chromium fires `onrtctransform` but never delivers encoded
> frames to the worker, so both counters read zero whatever the code does.
> The assertion has teeth only on an engine that runs the pipeline; the
> journey prints its counts so a vacuous pass is visible in the log.

Known gaps, tracked rather than hidden:
- **WebKit** — the dc-close departure signal (findings 1–4 of
  `REVIEW-round1.md`) is now wired end to end: a closed datachannel
  drops the leg, a graceful leave says `BYE` over the wire first, and a
  leg whose crypto channel never opened evicts + redials within ~8s.
  All but two journeys pass (the two skips are engine limits: WebKit
  `decodeAudioData` cannot decode MediaRecorder output, and its fake-mic
  stub cannot install on this engine). Remaining watch item: the WebKit
  wedge can still drop the signaling socket with the leg; recovery is
  the reconnect chain + socket-open re-dial, verified by unit tests and
  not known to wedge anymore.
- **Firefox** — Playwright cannot launch its bundled patched Firefox
  (`firefox-1555`) on this host at all ("Could not find profile folder",
  identical for stock runs outside Playwright — upstream
  microsoft/playwright#42768 class). Installing stock Firefox does **not**
  help: Playwright only ever launches its own build. The CI lane runs with
  `continue-on-error` until the host-level issue clears or a green CI run
  happens.

Join a room two ways: open a share link (`#CH.SECRET`), or pick a
channel + passphrase on the Join screen — both sides derive the same
room secret locally (argon2id via `hash-wasm`; fail-closed when WASM is blocked), so no
link needs to be sent. See `PLAN.md` for the rebuild roadmap.

Deploy `dist/` to **any static host with HTTPS** (Cloudflare Pages,
Netlify, GitHub Pages+proxy, etc.). No server-side code required.

## How it works

```
src/
  domain/       the machines — no DOM, all testable
    crypto/     room secrets → HMAC peer IDs, SAS codes, E2EE key
    state.ts    tiny reactive store (no framework)
    session/    session phase machine (pure transitions + effects)
    mesh/       parallel slot claim, secret-verified legs, watchdog
    security/   encoded-transform AES-GCM frame encryption
    audio/      PTT-gated mic manager, silent carrier, sfx
    battery.ts  battery API, power-save, visibility, wake lock
  app/          sequences the machines and owns effects
    session/    session orchestration, share links
    radio/      PTT, render loop, remote audio sink
    router/     hash router
  infra/        storage, DOM helpers
  ui/           components that subscribe to the store
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
- **SAS verification**: a 6-character code derived from the room secret
  + every leg's DTLS fingerprint appears on the LCD. Team members
  compare it out-of-band; a MITM changes it.
- **Mic on demand**: the hardware is acquired on the **first PTT press**
  and released the moment TX ends — nothing captures, and no device
  indicator is lit, between transmissions. The browser's permission prompt
  therefore lands when the mic is first actually required; once answered,
  the grant persists per origin and later presses skip it. Leaving a room
  hard-releases the hardware. Mic-test path is verified to hard-release.
- **Hardened page**: CSP with no third-party script origins, peerjs is
  bundled from npm (no CDN supply chain), fonts self-hosted, all
  peer-derived text rendered via `textContent` (XSS-safe).

## Battery design

- Mic hardware off unless transmitting — capture exists only between PTT
  press and release.
- Render loop is VAD-gated: 15 fps while someone speaks → 2 Hz poll
  when silent → fully stopped + AudioContext suspended with no peers.
- Wake lock held only during TX. Matrix rain is an ambient backdrop.
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
| 350–700 ms PTT latency | no warm window — each press pays a cold device wake; the grant persists after the first |
| rAF ran forever with peers linked | VAD-gated 15fps→2Hz→sleep ladder |
| Ghost legs from dialing empty slots | `peer-unavailable` cleanup + known-occupied watchdog |
| Broker `disconnected` fallback was a no-op | immediate reconnect + backoff + full rejoin |
| Share link `#ch` never parsed | hash-first session init with secret |
| Keypad dead after joining | rolling dial — type over to change channel |
| PTT pointer-only | keyboard: hold Space/Enter on the focused button |
