/* domain/session/session.ts — pure session state transitions.

   No side effects. No platform deps. Testable in isolation. */

import {
  SessionState,
  SessionPhase,
  initialSessionState,
  MeshPort,
  JoinResult,
} from './types.js';

export function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return { ...initialSessionState, ...overrides };
}

export function isJoining(state: SessionState): boolean {
  return state.phase === 'joining' || state.phase === 'rekeying' || state.phase === 'rejoining';
}

export function isIdleOrFailed(state: SessionState): boolean {
  return state.phase === 'idle' || state.phase === 'failed';
}

export function startJoinFromHash(
  state: SessionState,
  channel: string,
  secret: string
): SessionState {
  if (!isIdleOrFailed(state)) return state;
  return { ...state, phase: 'initializing', channel, secret, persist: true, radioInitialized: true };
}

export function startJoinFromScreen(
  state: SessionState,
  channel: string,
  secret: string,
  persist: boolean
): SessionState {
  if (!isIdleOrFailed(state)) return state;
  return { ...state, phase: 'initializing', channel, secret, persist, radioInitialized: true };
}

export function startRejoin(
  state: SessionState,
  channel: string,
  secret: string,
  persist: boolean
): SessionState {
  if (state.phase !== 'joined') return state;
  return { ...state, phase: 'rejoining', channel, secret, persist };
}

export function startRekeying(state: SessionState): SessionState {
  if (state.phase !== 'initializing' && state.phase !== 'rejoining') return state;
  return { ...state, phase: 'rekeying' };
}

export function startJoining(state: SessionState): SessionState {
  if (state.phase !== 'rekeying') return state;
  return { ...state, phase: 'joining' };
}

export function completeJoin(
  state: SessionState,
  success: boolean,
  meshChannel?: string | null
): SessionState {
  if (state.phase !== 'joining') return state;
  if (success && meshChannel === state.channel) return { ...state, phase: 'joined' };
  return { ...state, phase: 'failed' };
}

export function leaveSession(state: SessionState): SessionState {
  if (state.phase === 'idle') return state;
  return createSession({ radioInitialized: state.radioInitialized });
}

export function newIdentity(state: SessionState, freshSecret: string): SessionState {
  return { ...state, secret: freshSecret };
}

export function resetRadioInitialized(state: SessionState): SessionState {
  return { ...state, radioInitialized: false };
}

export interface JoinSideEffects {
  persist?: { channel: string; secret: string };
  startQualityPolling?: boolean;
  syncHash?: { channel: string; secret: string };
  showScreen?: 'radio' | 'join';
  showHintOnce?: boolean;
  errorToast?: string;
}

export async function executeJoin(
  state: SessionState,
  mesh: MeshPort
): Promise<[SessionState, JoinSideEffects]> {
  const { channel, secret, persist } = state;
  if (!channel || !secret) {
    return [state, { showScreen: 'join', errorToast: 'BAD KEY — CHECK LINK' }];
  }

  let s = startRekeying(state);
  s = startJoining(s);

  const joinResult = await mesh.join(channel);
  const success = joinResult?.ok === true && mesh.channel === channel;

  if (success) {
    const effects: JoinSideEffects = { startQualityPolling: true };
    if (persist) effects.persist = { channel, secret };
    effects.syncHash = { channel, secret };
    s = completeJoin(s, true, channel);
    return [s, effects];
  }

  const effects: JoinSideEffects = { showScreen: 'join' };
  if (joinResult?.ok) effects.errorToast = 'CHANNEL MISMATCH — RETRY';
  else if (joinResult?.reason === 'full') effects.errorToast = 'CHANNEL FULL — ALL SLOTS TAKEN';
  else if (joinResult?.reason === 'unreachable') effects.errorToast = 'SIGNAL UNREACHABLE — CHECK NETWORK/BROKER';
  s = completeJoin(s, false);
  return [s, effects];
}

export interface LeaveSideEffects {
  stopQualityPolling: boolean;
  meshLeave: boolean;
  showScreen: 'join';
}

export function executeLeave(state: SessionState): [SessionState, LeaveSideEffects] {
  if (state.phase === 'idle') return [state, { stopQualityPolling: false, meshLeave: false, showScreen: 'join' }];
  const s = leaveSession(state);
  return [s, { stopQualityPolling: true, meshLeave: true, showScreen: 'join' }];
}