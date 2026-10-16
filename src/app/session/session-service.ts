/* app/session/session-service.ts — session orchestration.

   Owns the session state machine and keeps it in sync with the two
   downstream stores that read room identity:
   · domain/state (global radio state): mesh joins and share links read
     channel/secret from here, so every transition mirrors them.
   · the mesh's E2EE engine: derived here from the room secret, injected
     into the mesh via setE2ee() before any leg negotiates.
   · the render loop's AudioContext suspend hook (on loop sleep). */

import {
  SessionState,
  SessionDeps,
  E2eeInstance,
} from '../../domain/session/types.js';
import { set } from '../../domain/state/state.js';
import {
  createSession,
  startJoinFromHash,
  startJoinFromScreen,
  startRejoin,
  executeJoin,
  executeLeave,
  newIdentity,
  resetRadioInitialized,
  isJoining,
} from '../../domain/session/session.js';

export class SessionService {
  private state: SessionState;
  private deps: SessionDeps;
  private e2eeInstance: E2eeInstance | null = null;
  private hintShown = false;
  private gen = 0;                 // join generation — see runJoin
  private listeners: Set<(state: SessionState) => void> = new Set();

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.state = createSession();
  }

  getState(): Readonly<SessionState> { return this.state; }
  isJoining(): boolean { return isJoining(this.state); }

  subscribe(fn: (state: SessionState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  private transition(next: SessionState): void {
    this.state = next;
    this.emit();
  }

  /* Derive the per-room E2EE engine and hand it to the mesh. Runs before
     every join; a null instance means SRTP-only legs. */
  private async rekeyE2EE(): Promise<void> {
    const { secret } = this.state;
    if (this.e2eeInstance) {
      try { this.e2eeInstance.destroy(); } catch { /* noop */ }
      this.e2eeInstance = null;
    }
    if (!secret || !this.deps.e2ee.supported()) {
      this.deps.mesh.setE2ee(null);
      set({ e2eeMode: this.deps.e2ee.supported() ? 'e2ee-ready' : 'dtls-only' });
      return;
    }
    try {
      const raw = await this.deps.e2ee.deriveRawGroupKey(crypto.subtle, secret);
      this.e2eeInstance = this.deps.e2ee.create(raw, this.deps.log);
      this.deps.mesh.setE2ee(this.e2eeInstance);
      set({ e2eeMode: 'e2ee-ready' });
    } catch (err) {
      this.e2eeInstance = null;
      this.deps.mesh.setE2ee(null);
      set({ e2eeMode: 'dtls-only' });
      this.deps.log(`E2EE UNAVAILABLE — ${err instanceof Error ? err.message : String(err)} — SRTP ONLY`, 'warn');
    }
  }

  async initFromHash(channel: string, secret: string): Promise<boolean> {
    if (isJoining(this.state)) return false;
    const next = startJoinFromHash(this.state, channel, secret);
    /* same rule as initFromJoin: a refused transition returns the same
       object — never re-run a join for a room we are already on */
    if (next === this.state) return false;
    this.transition(next);
    return this.runJoin();
  }

  async initFromJoin(channel: string, secret: string, persist: boolean): Promise<boolean | 'busy'> {
    if (isJoining(this.state)) return 'busy';
    const next = startJoinFromScreen(this.state, channel, secret, persist);
    /* a refused transition returns the same object — never claim a join
       that never started */
    if (next === this.state) return 'busy';
    this.transition(next);
    return this.runJoin();
  }

  async rejoin(channel: string, secret: string, persist?: boolean): Promise<boolean> {
    if (this.state.phase !== 'joined') {
      /* not joined: the router still wants a fresh join attempt */
      return (await this.initFromJoin(channel, secret, persist ?? this.state.persist)) === true;
    }
    const p = persist ?? this.state.persist;
    this.deps.mesh.stopQualityPolling();
    this.deps.mesh.leave();
    this.transition(startRejoin(this.state, channel, secret, p));
    return this.runJoin();
  }

  private async runJoin(): Promise<boolean> {
    const { channel, secret } = this.state;
    /* Generation guard. Every leave/new-join bumps it, so a join that is
       still awaiting the broker when the user leaves (or starts another
       room) must NOT apply its result: that re-persists the key, restarts
       polling, rewrites the URL back to the abandoned room and lands the
       phase on 'joined' — a ghost session on a room nobody is in. */
    const gen = ++this.gen;
    const stale = (): boolean => gen !== this.gen;
    /* mirror into global state BEFORE mesh.join — the mesh reads
       state.secret for the room identity and aborts NO SECRET otherwise */
    set({ channel, secret });

    await this.rekeyE2EE();
    if (stale()) return false;
    this.deps.ui.showScreen('radio');

    const [nextState, effects] = await executeJoin(this.state, this.deps.mesh);
    if (stale()) return false;

    if (effects.persist) {
      this.deps.storage.set('wlk1-ch', effects.persist.channel);
      this.deps.storage.set('wlk1-key', effects.persist.secret);
    }
    if (effects.startQualityPolling) this.deps.mesh.startQualityPolling();
    if (effects.syncHash) this.deps.ui.syncRadioHash(effects.syncHash.channel, effects.syncHash.secret);
    if (effects.showScreen) this.deps.ui.showScreen(effects.showScreen);
    if (effects.errorToast) this.deps.ui.toast(effects.errorToast);

    this.transition(nextState);

    if (nextState.phase === 'joined' && !this.hintShown) {
      /* The mic is NOT touched here: the permission prompt and the capture
         window belong to the PTT gesture itself (mic.ts), never to the
         join. Nothing is asked until the mic is actually required. */
      this.hintShown = true;
      this.deps.ui.showHintOnce();
    }
    return nextState.phase === 'joined';
  }

  async leave(): Promise<void> {
    /* Invalidate any join still in flight — its result must not land. */
    this.gen++;
    const [nextState, effects] = executeLeave(this.state);
    if (effects.stopQualityPolling) this.deps.mesh.stopQualityPolling();
    if (effects.meshLeave) this.deps.mesh.leave();
    this.deps.mic.release();                 // no room outlives its hardware
    if (effects.showScreen) this.deps.ui.showScreen(effects.showScreen);
    this.deps.ui.clearWords();

    if (this.e2eeInstance) {
      try { this.e2eeInstance.destroy(); } catch { /* noop */ }
      this.e2eeInstance = null;
    }
    this.deps.mesh.setE2ee(null);
    set({ channel: null, secret: null, e2eeMode: 'off' });

    this.transition(nextState);
  }

  async newIdentity(generateSecret: () => string): Promise<void> {
    const fresh = generateSecret();
    const wasJoined = this.state.phase === 'joined';
    this.transition(newIdentity(this.state, fresh));
    if (this.state.persist) this.deps.storage.set('wlk1-key', fresh);
    set({ secret: fresh });
    if (wasJoined) await this.rejoin(this.state.channel!, fresh);
    this.deps.ui.toast('NEW IDENTITY — SHARE THE NEW LINK');
    this.deps.log('NEW IDENTITY — KEYS ROTATED', 'sys');
  }

  resetRadioInitialized(): void {
    this.transition(resetRadioInitialized(this.state));
  }
}
