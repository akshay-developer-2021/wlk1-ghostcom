# WLK-1 GHOSTCOM — Rebuild Plan (libs + TS + perf)

> Direction: no more hand-rolled protocol code. Industry-standard libs where
> they exist, TypeScript everywhere, bundle budget enforced. Zero-backend
> P2P architecture stays.

Status: `src/core/battery.js` Firefox-kill fix landed (verified, tests 31/31).
Everything below is queued work, ordered.

---

## 0. Brutal per-flow review (verified against code, Oct 2026)

Flows: Boot → Session → Join/Claim → Mesh legs → TX path → RX path →
E2EE handshake → UI/State → Power. Only defects that can silence TALK.

| # | Flow | Defect | File:line | Severity | Status |
|---|------|--------|-----------|----------|--------|
| 1 | Boot | `getBattery?.().then` throws where Battery API is missing (Firefox, Safari) — top-level throw kills the whole module before join | `core/battery.js:18` | P0 app-dead | FIXED |
| 2 | TX release | `endTx` passes a `MediaStream` to `replaceTrack()` (takes a track) — always throws/swallowed, senders keep the live mic track (privacy leak + dead air after warm expiry) | `webrtc/mesh.js:460` | P0 | queued |
| 3 | E2EE | Worker implements only `onmessage`; `RTCRtpScriptTransform` path delivers frames via `onrtctransform` — any successful E2EE handshake on a ScriptTransform browser black-holes audio with an `E2E` badge | `security/e2ee.js:14-61,88-89` | P0 landmine | queued |
| 4 | RX | Remote `<audio>.play()` rejection never retried; `srcObject` never updated on redialed streams — silent legs with LINKED UI | `main.js:206-226` | P0 | queued |
| 5 | TX | Warm-resume returns `ended` tracks without `readyState` check — full TX UI, digital silence | `audio/mic.js:53-64` | P0 | queued |
| 6 | Mesh | Bare `call.answer()` (recvonly) + `replaceTrack` counted as success — permanent one-way deafness, redial rescue never fires | `webrtc/mesh.js:240-252,412-444` | P0 | queued |
| 7 | Mesh | Single-dialer design (`j < mySlot`) + skipped pre-gesture dial = nobody dials; `beginTx` can't heal empty legs | `webrtc/mesh.js:112,190-213` | P0 | queued |
| 8 | Mesh | Repair paths violate dial direction → duplicate legs → close-handler cross-kills the live leg | `webrtc/mesh.js:264,268-276` | P0 | queued |
| 9 | Session | Hash-join never persists creds — reopen without link strands user in dead room | `main.js:44-58` | P0 | queued |
| 10 | Session | Secret validation is case-sensitive, derivation isn't — lowercased link silently mints a solo room | `core/crypto.js:39-41` | P0 | queued |
| 11 | Mesh | `peer-unavailable` evicts `knownOccupied` — peer rejoining after reload is never redialed | `webrtc/mesh.js:143-155` | P0 | queued |
| 12 | PTT | `onAnalyser()` inside TX try-block — a meter throw aborts TX as fake "MIC BLOCKED" | `ui/ptt.js:51` | P1 | queued |
| 13 | PTT | `await mesh.join` outside try — throw leaves button latched | `ui/ptt.js:32-43` | P1 | queued |
| 14 | Session | `micTest` stops live/warm tracks mid-TX | `main.js:167-182` | P1 | queued |
| 15 | E2EE | Data-before-leg race closes the crypto channel → capable legs stuck SRTP forever | `webrtc/mesh.js:288-318` | P1 | queued |
| 16 | Join | `Promise.all` waits the 4s probe tail; full-vs-unreachable heuristic misdiagnoses | `webrtc/mesh.js:91-104` | P1 | queued |

Research update (Oct 2026): Encoded Transforms are **Baseline 2025** —
Firefox 117+, Safari 15.4+, Chromium all ship `RTCRtpScriptTransform`.
The E2EE path is viable on every modern browser, which upgrades #3
from "Chromium-only landmine" to "every-browser landmine": fix first.

---

## 1. Library decisions (only well-supported, standard picks)

Principle: take a dependency only if it is maintained, typed, and
tree-shakeable. Everything else stays zero-dep.

| Area | Pick | Why | Replaces |
|------|------|-----|----------|
| Signaling + PeerConnection compat | **Keep `peerjs@1.5.x`** (13k★, MIT, 21k weekly DL, BrowserStack-tested FF/Chrome/Edge/Safari, ships own types). It already bundles **`webrtc-adapter@9`** (the official cross-browser shim, 962 dependents) — RTC-level compat is covered. Self-host **PeerServer** + own **coturn** for prod (both standard, documented by PeerJS). | nothing — already correct |
| E2EE framing | **No library — fix own worker.** Verified: no standalone industry-standard SFrame JS lib exists (LiveKit E2EE is coupled to `livekit-client`/server concepts; Jitsi E2EE is coupled to `lib-jitsi-meet`; native `SFrameTransform` support is draft-stage). Our worker is ~60 lines: add the missing `onrtctransform` handler, keep the `createEncodedStreams` fallback, align the frame format toward SFrame (RFC 9605) header layout later. Small, auditable, no bundle cost. | home-rolled `onmessage`-only worker |
| Passphrase KDF | **`hash-wasm` (argon2id)** — maintained, 11 kB gzip WASM bundled as base64 (no `.wasm` hosting/CSP hassle), all modern browsers + Node, TS types included. Import the argon2 entry **dynamically** (`await import('hash-wasm')` inside the passphrase flow only) so the radio bundle never pays for it. Fallback: WebCrypto PBKDF2 (zero bytes) if WASM unavailable. | WebCrypto-only PBKDF2 |
| Cross-browser proof | **`@playwright/test` (dev only)** — Microsoft-maintained industry standard, real Chromium + Firefox + WebKit. Headless join/talk matrix replaces "works on my Mac" forever. Browsers download to dev machines only, never shipped. | manual tab testing |
| PWA packaging | **`vite-plugin-pwa`** (Workbox-based standard, `injectManifest` to keep our custom SW logic) — correct precaching/versioning instead of hand-rolled `public/sw.js`. | hand SW registration |
| Language | **`typescript` (dev) + `tsc --noEmit`** — Vite transpiles TS natively; typecheck runs as its own script. | plain JS |

**Explicitly rejected:** `livekit-client` / SFU servers (need servers, break
zero-backend, overkill for ≤8-peer mesh — PeerJS FAQ: a peer holds a handful
of connections, exactly our size); `argon2-browser` (older, heavier, separate
`.wasm` asset + CSP friction); `@vitejs/plugin-legacy` (doubles bundles for
dead browsers that can't do E2EE anyway — use `baseline-widely-available`
target instead); any state/router framework (a 40-line hash router is smaller
than any dep).

**Why TS, why not JS:** the prototype was JS for speed. TS now because (a)
defect #2 (`replaceTrack(MediaStream)`) is a *compile error* in TS —
`strict` + DOM lib types kill this whole bug class; (b) `strictNullChecks`
kills the silentStream-null class; (c) every dep above ships first-party
types, so zero `@types` friction; (d) vitest runs TS natively, Playwright
tests will be TS too.

---

## 2. TypeScript migration (incremental, no freeze)

1. `npm i -D typescript` + `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`,
   `moduleResolution: bundler`, `target/baseline-widely-available`, `types: ["vite/client"]`.
2. `npm run typecheck` (`tsc --noEmit`); wire into `npm test` pipeline.
3. Rename in dependency order (each step must stay green):
   `core/*` → `audio/*` → `security/*` → `webrtc/*` → `ui/*` → `main.ts`,
   then `vite.config.ts`. Tests convert last (vitest needs no config change).
4. Type the leg state machine (`LegState`), mesh events, and store
   (`state.ts`) first — highest bug density per the review.
5. Enable `noUnusedLocals` after the rename pass; fix fallout.

---

## 3. Performance plan (budgets, not vibes)

Budgets (gzip, enforced by `rollup-plugin-visualizer` in CI):
app JS ≤ 60 kB · peerjs chunk ≤ 30 kB · fonts ≤ 60 kB · total initial ≤ 200 kB.

- **Fonts (biggest win):** current `dist/` is ~1.1 MB, mostly full-alphabet
  `@fontsource` pulls (vietnamese/greek/cyrillic shipped for a VT323 LCD).
  Switch to subset imports (`latin-400.css`-style entries), verify with build.
- **Dynamic KDF:** argon2 WASM loads only inside the passphrase flow.
- **Build:** `target: 'es2022'` (Vite 6's esbuild predates the
  `baseline-widely-available` label — same modern profile), `sourcemap: false`
  (maps currently ship to Surge — dead weight + source exposure),
  keep `manualChunks: { peerjs }`, `chunkSizeWarningLimit: 60`.
- **Tree-shaking:** named ESM imports everywhere; no side-effect adapter
  import (PeerJS already pulls what it needs); audit with visualizer.
- **Runtime (keep):** cold mic, VAD-gated loop, wake-lock-only-TX,
  hidden-tab guards — already good, add Playwright perf smoke (join time).

---

## 4. SPA plan (screens, still zero-backend)

It is already a single page; make it a proper *screened* SPA with a
40-line hash router (no framework — smaller than any dep):

- Screens: **Join** (channel + mode tabs Link/Passphrase, strength meter,
  recent rooms) → **Radio** (current UI) → **Settings** (broker/TURN override,
  diagnostics, copy-logs, key rotation).
- URL contract (backward compatible): `#22.SECRET` (today) keeps working;
  passphrase mode puts only `#c=22` in the URL — never the secret.
- Boot router: hash with SECRET → radio immediately; `#c=` or bare →
  Join screen (no auto-join into dead rooms — fixes defect: Solo-by-default).
- Passphrase lives in `sessionStorage` (tab lifetime) unless user opts into
  remember (then passphrase-derived *secret*, never the words, in
  localStorage). New identity per tab stays possible via `?fresh`.

---

## 5. Passphrase plan (retire the link)

Goal: two friends agree verbally on **frequency + passphrase**, nothing to send.

- `roomSecret = CrockfordBase32( Argon2id( NFKC(passphrase), salt="wlk1·v1·CH"+channel, mem 16 MiB, iter 3, out 10 bytes ) )`
  — output feeds the *existing* pipeline unchanged (peer IDs, E2EE key, SAS).
  Salt-from-channel is the trick that removes key exchange: both sides
  compute the same salt locally.
- Normalization: NFKC, trim, collapse whitespace; **case-sensitive by
  default** (show it), strength meter requiring ≈ 4 random words / 20+ chars.
- Honest threat table in Settings: link mode (80-bit random, unguessable)
  vs passphrase mode (guessable — anyone who knows channel + guesses words
  can derive your IDs and attempt joins; SAS check stays mandatory).
- Link mode remains for high-security; passphrase is convenience tier.

---

## 6. Frequency-hopping verdict: no

Researched, and the answer is no — as a *security* feature it is theater here:

- NIST SP 800-121: FHSS gives "limited"/"minimal" transmission security;
  it is anti-jam/anti-interference, not encryption. Military systems pair it
  with real COMSEC/TRANSEC crypto (e.g. R&S SECOS: user cipher *plus*
  hopping) — hopping is never the security layer.
- We have no radio medium: "22.01 → 22.02" is just a name change. It forces
  re-claim + re-dial + re-handshake every hop (seconds of dead air, battery,
  broker spam) while costing an attacker nothing (broker sees all IDs anyway;
  with the secret they follow trivially; without it they can't find *any*
  channel).
- Real levers, in order: strong secret → SAS check → own broker/TURN.
- If hopping is still wanted as anti-jam *UX* later: pre-shared schedule
  `HMAC(secret, epoch)` with epoch beacons over the data channel — Phase 3
  at earliest, off by default. Not recommended.

---

## 7. Execution order

- Phase 0: defects #2–#11 (talk path), worker `onrtctransform`, TS migration §2.
- Phase 1: screens/router §4 + passphrase §5 (`hash-wasm` dynamic).
- Phase 2: `vite-plugin-pwa`, Playwright matrix, self-hosted PeerServer/coturn,
  SFrame-header alignment, font/treeshake budgets §3.
- Phase 3 (maybe never): hop schedule. Probably never.
