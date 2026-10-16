# WLK-1 GHOSTCOM — State Machine Reference

The radio is four cooperating state machines. This maps each one, its
guards, and the invariants that are easy to break.

Layering: `domain/` holds the machines and knows no DOM. `app/` sequences
them and owns effects. `ui/` subscribes to `domain/state` and renders. The
session machine is pure (`domain/session/session.ts`) — every transition is
a testable function with no side effects; `SessionService` runs them.

---

## 1. Session (`domain/session/session.ts`, `app/session/session-service.ts`)

**Phases** (`domain/session/types.ts`):
`idle` → `initializing` → `rekeying` → `joining` → `joined` | `failed`,
plus `rejoining` (leaving a live session for a different room).

| Transition | Trigger | Guard |
|---|---|---|
| `idle`/`failed` → `initializing` | `startJoinFromHash` (share link / route) | `isIdleOrFailed` |
| `idle`/`failed` → `initializing` | `startJoinFromScreen` (join screen, recents) | `isIdleOrFailed` |
| `joined` → `rejoining` | `startRejoin` (keypad roll, new identity) | `phase === 'joined'` |
| `initializing`/`rejoining` → `rekeying` | `startRekeying` inside `executeJoin` | — |
| `rekeying` → `joining` | `startJoining` inside `executeJoin` | `phase === 'rekeying'` |
| `joining` → `joined` | `completeJoin(true, meshChannel)` | success **and** `mesh.channel === state.channel` |
| `joining` → `failed` | `completeJoin(false)` | — |
| any → `idle` | `leaveSession` | — |

**Invariants**
- `startJoinFromScreen` returns the *same object* when the session is
  already live. `SessionService.initFromJoin` treats that identity as a
  refusal and returns `false` — never a silent success over a live radio.
  Dialing from the radio therefore goes through `rejoin`.
- Room identity is mirrored into `state.{channel, secret}` **before**
  `mesh.join()`; the mesh reads the secret to derive peer IDs and aborts
  without it.
- The E2EE engine is re-derived from the secret and injected via
  `mesh.setE2ee()` before any leg negotiates.
- `leave()` also clears the passphrase field and its strength meter —
  the field and the meter are one thing.

## 2. Router (`app/router/router.ts`, `router-service.ts`)

Hash → route on load and on every `hashchange`.

| Hash | Route | Action |
|---|---|---|
| `#settings[?…]` | settings | `showScreen('settings')` + `refreshSettings()` |
| `#c=NN`, `#NN`, `#` | join | `session.leave()` when not idle → `prefillJoin` → join screen |
| `#NN.SECRET` (valid) | radio | `initFromHash` when idle, else `rejoin` |
| `#NN.junk` | join | channel is still prefilled |

Secret validity is owned by `crypto.isValidRoomSecret` — the router must
not carry its own copy of the alphabet. Room secrets are Crockford base32
(`0-9`, no `I/L/O/U`), so a hand-typed link is normalized (trim, uppercase).

## 3. Mesh (`domain/mesh/mesh.ts`)

**Room identity.** Peer IDs are `wlk1-HMAC(secret, slot)`. A room is
un-enumerable: without the secret you cannot find, squat, or even address
its peers. Consequence — rotating the secret makes the peer unreachable
for the old room until the new link is shared. That is by design.

**Slot claim.** N probes, staggered; the first `open` wins, late probes
destroyed. `full` only when every resolved result is `unavailable-id`;
`unreachable` when none resolved (firewalled, not full).

**Per-leg:** `dialing` → `connecting` → `connected`, with two demotions:
- never-connected (ICE never reached `connected`) → forced redial
- consecutive misses (3) → **parked**; the watchdog skips parked slots and
  a force bypass redials them anyway.

**Proof of life.** A leg counts as linked only once a remote stream
arrives. Redialing a streaming slot keeps it lit.

**E2EE attach.** `RTCRtpScriptTransform` is detected via the `transform`
instance accessor — the legacy `createEncodedStreams` path is deprecated
and rejects any attach after a sender starts sending, which silently
downgrades a leg to SRTP. A leg that cannot arm logs `E2EE UNAVAILABLE`
and keeps working as SRTP; the badge reflects the weakest leg.

**Guards:** `_joinMutex` (one join at a time), `_reconnectChain` (single
broker reconnect), `_txGen` (stale async TX callbacks drop out), and
`_seenPeers` which survives `unavailable-id` rejoins.

## 4. PTT and mic

**PTT holders** are refcounted (`pointer`, `space`, `t`, `enter`, `api`):
a gesture ending while another is held cannot drop TX. A generation token
invalidates async arming, and `maxTxMs` force-ends a stuck TX. Global
shortcuts stand down over text fields, the focused volume slider, and the
hint dialog. View changes must never park focus on an input — the keypad
ignores keydown from inputs, so that would kill every shortcut.

**Mic** hands out a generation token with every acquire: a released button
can never latch a live mic. After `warmWindowMs` the track is stopped and
the OS indicator goes dark. Callers must compare the generation before any
side effect.