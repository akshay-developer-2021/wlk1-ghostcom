# REVIEW round 1 — layered rebuild (uncommitted change set, 2026-10-16)

Scope reviewed: full uncommitted diff (app/domain/infra/ui split, session state
machine, hash router, UI components, new Playwright suite). All findings confirmed
by reading current code + re-running suites.

## Status after the fix round (2026-10-16 evening)

Findings 1–7 implemented. Gates re-run:
- typecheck clean; build clean; unit tests 138/138 (129 prior + 9 new regression tests).
- chromium journeys: 9/9 pass.
- webkit journeys: 7/7 active pass (2 engine-limit skips: decodeAudioData,
  fake-mic stub). `lone survivor` now passes — the fix went beyond the review's
  5-line sketch, see finding 1 note.
- firefox journeys: BLOCKED at host level — Playwright cannot launch Firefox on
  this machine (`Could not find profile folder`, exitCode=1 immediately; killed
  processes, wiped the playwright browser cache, tried `MOZ_*`/`XRE_*` env
  fixes, `mkdir -p ~/Library/{Caches,Application Support}/Mozilla`, even the
  upstream `-app application.ini` workaround — nightly 1555 / Firefox 157).
  Stock-condition upstream match: microsoft/playwright#42768 (macOS TCC vs
  Gecko profile bookkeeping; stock Firefox fails the same way outside
  Playwright). Not app code. CI matrix lane stays `continue-on-error` until a
  build host can launch Firefox; app-level Firefox work un_started.
- e2e-webkit CI job promoted to enforced (finding 7).

## Proof at review time
- typecheck clean; build clean; unit tests 129/129 pass.
- e2e chromium journeys: 9/9 pass.
- e2e webkit journeys: 1 fail (`lone survivor`), 2 skipped; firefox journeys no
  launch locally (Playwright Nightly profile error — env, not app code).

## Must fix

**1. DONE — src/domain/mesh/mesh.ts:715-723** — `conn.on('close')` in
`_wireCryptoConn` now runs `_dropLeg()` (the shared teardown, mesh.ts:565-588:
close call, timers, SAS listeners, `legs.delete`, `_sasPrints`, dataconn close,
`removePeer`, LINK DROPPED + sfx + `_emitCrypto`), stale-guarded on leg
identity so a TX redial reusing the dc can't cross-kill the new leg
(tests/mesh.test.js "crypto dataconn close — the cross-browser departure
signal", 2 tests). Two engine realities forced three companions beyond the
5-line sketch, all inside existing mesh files:
- graceful leave says BYE on the wire first — `mesh.leave()` broadcasts
  `{t:'wlk1-bye'}` on every open dataconn (mesh.ts:738-749) and the wire
  handler drops the leg on receipt (mesh.ts:700-704) — WebKit can delay/trash
  the dc close on leaves;
- socket-open self-heal — after the WebKit wedge takes the signaling socket
  down WITH the leg, `p.on('open')` re-dials seen peers while zero legs live
  (`_redialSeenPeers`, mesh.ts:346-383, mirrors the `beginTx` zero-leg sweep);
- wire-strand eviction — a leg whose crypto channel never OPENED cannot carry
  BYE/close events, so it evicts + redials ~8s after negotiation
  (`WIRE NEVER-OPENED`, mesh.ts:662-687). This is what finally turned WebKit
  `lone survivor` green: the journey's user leaves ~0.5s after link, before
  WebKit ever opens the channel.

**DONE (preferred branch) — src/main.ts (onDial).** Scan-return block deleted;
all three journeys that asserted the old behavior rebuilt (dial stays on the
typed channel). Full detail under finding 2 below.

2. ~~Scan-return bounces users off occupied channels — `src/main.ts:142-148`.~~
   **DONE.** Keypad dial rolls back to previous room after 1200 ms when
   `mesh.linked.length === 0`. `linked` counts media-proven peers only; friend on
   dialed channel links in 0.7–2.5 s (longer over TURN) — fixed 1.2 s check = race.
   Losing it teleports user back, other user sees them vanish, no log, no retry.
   Old code had no scan-return.
   Fix: delete scan-return block (preferred), or roll back only on evidence
   (claim-time dials answered), never on clock.

**DONE — src/ui/components/join-screen.ts:50-52 (tri-state `onJoin` →
`Promise<boolean | 'busy'>`), src/domain/session/session.ts:120-122
(unreachable toast `SIGNAL UNREACHABLE — CHECK NETWORK/BROKER`),
src/app/session/session-service.ts:94-102 (`initFromJoin` returns `'busy'`
for both isJoining and refused-transition; failed still false; `rejoin`
coerces `=== true`).** Tests: session.test.js "refuses a screen-join…" now
expects `'busy'`, plus new "reports busy while a join already runs" and
"an unreachable broker keys its own diagnosis".

3. ~~Every failed join reports "BUSY — A JOIN IS ALREADY RUNNING"~~ — **DONE**, see above block.

**DONE — src/main.ts onDial (`pushRecent(ch, null)` moved into the `ok`
branch after rejoin resolves).** A failed dial no longer rewrites the
recent entry; saved-key pointers survive.

4. ~~Failed keypad dial erases saved-key pointer in recents — `src/main.ts:129-131`.~~
   **DONE**, see above block.
   `pushRecent(ch, null)` runs before rejoin; `pushRecent`
   (`src/ui/components/recent-rooms.ts:31-37`) replaces channel entry wholesale.
   Failed dial downgrades `CH 22 · KEY SAVED` to `NEEDS KEY`.
   Fix: move `pushRecent(ch, null)` into `ok` branch after rejoin resolves.

## Should fix

**DONE — src/app/router/router-service.ts:39,44.** Both router-initiated join
chains (`rejoin`, `initFromHash`) `.catch` into
`session.leave().catch()` so a rejecting join lands back on the join screen
instead of an unhandled rejection. (`buildJoinHash` import removal from this
file is the only dead-code touch from finding 8 the fix needed.)

5. ~~Router promise follow-ups no `.catch`~~ — **DONE**, see above block.

**DONE — src/app/radio/remote-audio.ts (setVolume + one shared GainNode,
routeSink) + src/ui/components/volume-slider.ts:7,11,19,32 (`VolumeDeps`
`onLevel` callback) + src/main.ts (`initVolume({onLevel: …}))`**. While the
media ctx runs (`state === 'running'`) the element is muted and loudness goes
`src → sharedGain → ctx.destination`, driven by the slider via
`setVolume`; otherwise (pre-gesture, tests, engines without the ctx) the
element stays the fallback (`volume = clamp01(level)`). `replayAudio`
re-routes on every gesture-unlock. TX path untouched (analyser only, no gain
on the mic feed). Unit-tested with a stateful fake ctx
(remote-audio.test.js "routes remote audio through the WebAudio gain path…").
On-device iOS verification remains open (platform constraint, flagged in the
review too).

6. ~~Volume knob does nothing on iOS~~ — **DONE in code**, device check outstanding.

**DONE — .github/workflows/ci.yml (new `e2e-webkit` enforced job +
`e2e-matrix` slimmed to firefox-only `continue-on-error`).** WebKit journeys
7/7 active (2 skips are engine limits documented in the journeys) — enforced
on CI. Firefox can't launch on this host (upstream
microsoft/playwright#42768 class — stock Firefox fails identically outside
Playwright), so its lane stays advisory until a working build host; README
documents both.

7. ~~Cross-browser gate still not green~~ — **DONE** (webkit enforced; firefox advisory + documented), see above block.

## Nice to have (lean, ~35 lines total)

8. Skipped by design, except the one step the fixes needed: the unused
   `buildJoinHash` import left `router-service.ts` was dropped (the export in
   `src/app/router/router.ts:39-41` stays). `E2EE.stats()` plumbing,
   `SessionService.subscribe/emit/listeners`, `join-screen.ts isJoining()`,
   `parseChannelHash` on `CryptoPort` — untouched.
9. Skipped: two storage wrappers (`src/infra/storage/storage.ts` vs
   `safeGet/safeSet/...` in `src/infra/dom/dom.ts:102-120`) both remain.

## Not checked / not verifiable here
- iOS Safari on-device (volume finding = platform docs, not a run).
- Real-device E2EE on WebKit (`transform` on prototype assumed; fallback honest SRTP).
- Firefox engine journeys (local Playwright Nightly no launch; CI never ran it).
- Production signaling default: public PeerJS cloud can return HTTP 429 to real
  visitors (`e2e/utils/env.ts` documents) — needs self-hosted broker.

## Review ground rules used (keep for round 2)
- Verify by re-reading callers of anything changed; fix must not break journeys.
- Findings 1-7 only; 8-9 optional. No new layers, no new dependencies, delete
  before add. No comments except `why` lines.
- Gate: typecheck, 129 unit tests, build, chromium journeys pass, webkit `lone
  survivor` passes after fix 1.

## Rereview round 2 — independent verification (2026-10-17)

Fixes 1-7 verified by re-reading the code and re-running every gate, not by
trusting the summary:
- Gate re-run clean: typecheck; units **138/138**; build; chromium 12 passed
  (10 journeys + batch + 2 smoke); webkit 10 passed / 2 skipped — `lone
  survivor` 10.8s ✓; firefox host block **reconfirmed** (`firefox.launch()`
  with and without `firefoxUserPrefs` fails identically: `Could not find
  profile folder`).
- Fix 1 verified: `_dropLeg` (mesh.ts:566-588) is the shared teardown; call
  close, call error, dc close (mesh.ts:715-724, stale-guarded), and `wlk1-bye`
  (mesh.ts:700-703) all route into it. BYE broadcast before close in `leave()`
  (mesh.ts:740-750). Wire-strand timer (mesh.ts:662-686) clears on dc open and
  is identity-guarded. `_redialSeenPeers` on socket open (mesh.ts:346-383)
  reuses the beginTx zero-leg sweep.
- Fixes 2-7 verified: `pushRecent(ch, null)` only after `rejoin` resolves ok
  (main.ts:136); scan-return block gone; join-screen `'busy'` tri-state +
  session.ts:120-122 unreachable toast + session-service.ts:94-102; router
  `.catch` both chains (router-service.ts:39,44); remote-audio shared GainNode
  + `routeSink` fallback to `el.volume` (remote-audio.ts:66-86) +
  volume-slider `onLevel` (volume-slider.ts:7,19,32); ci.yml `e2e-webkit`
  enforced, firefox-only advisory lane.

### NEW must fix (test infra, 2 lines)

**e2e/batch-1x1.spec.ts:27,49-50 — batch ignores the project browser.** `launchUser`
defaults to `'chromium'` and neither call passes `browserName` (read from
`testInfo.project.name` at :43 but used only for `measureAudio`). Every batch
run launches chromium — under `--project=firefox` and `--project=webkit` too.
Consequences: the webkit batch "pass" proves nothing about WebKit, and its
`measureAudio=false` skips the tone round trip anyway; the firefox lane shows
one green test (batch) while all journeys fail, muddying the advisory signal.
Fix: `launchUser(\`alice#${i}\`, browserName)` (same for bob). Regression proof:
batch under `--project=webkit` must show webkit-flavoured logs / fail if the
engine-specific path breaks.
**DONE — batch-1x1.spec.ts:49-50** — both `launchUser` calls now pass
`browserName`; engine-selection + mic handling inside `launchUser` were already
correct. Verified by running the batch under `--project=webkit` (real WebKit
processes, passes) and `--project=chromium` (stays green).
Firefox note for the record: stock Firefox installed on this host does not
unblock Playwright — the launcher only ever runs its bundled patched build
(`firefox-1555`, still "Could not find profile folder" even with a pre-made
profile and `TMPDIR=/tmp`); README wording tightened accordingly; lane stays
advisory.

### Residual risks (accepted, watch list)
- Wire-strand eviction (8s) can tear down a media-live leg whose datachannel
  never opens (rare dc-pc-vs-media-pc ICE asymmetry): one redial blip, parked
  after 3 strikes, re-probed by the watchdog slow lane. Self-heals; no known
  repro on the tested engines.
- BYE delivery races the immediate `conn.close()` in `leave()` — green in
  every tested path; on-device WebKit leave timing unverified.
- iOS on-device volume routing + real-device WebKit E2EE transform: unverified
  (platform constraints, unchanged from round 1).
