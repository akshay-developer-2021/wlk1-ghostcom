/* domain/session/types.ts — session domain types & interfaces (ports). */

import { Mesh } from '../mesh/mesh.js';
import { E2EE } from '../security/e2ee.js';

export type SessionPhase =
  | 'idle'              // at join screen, no session
  | 'initializing'      // hash route or saved creds, validating
  | 'rekeying'          // deriving E2EE keys
  | 'joining'           // mesh.join() in flight
  | 'joined'            // mesh joined, quality polling active
  | 'failed'            // join failed, back to join screen
  | 'rejoining';        // hash navigation to different room

export interface SessionState {
  phase: SessionPhase;
  channel: string | null;
  secret: string | null;
  persist: boolean;
  radioInitialized: boolean;
}

export const initialSessionState: SessionState = {
  phase: 'idle',
  channel: null,
  secret: null,
  persist: false,
  radioInitialized: false,
};

export interface JoinResult {
  ok?: boolean;
  reason?: string;
  slot?: number;
}

/** Port: Mesh operations needed by session. */
export interface MeshPort {
  join(channel: string): Promise<JoinResult | undefined>;
  leave(): void;
  startQualityPolling(): void;
  stopQualityPolling(): void;
  setE2ee(instance: E2eeInstance | null): void;
  readonly channel: string | null;
}

/** Port: E2EE operations needed by session. */
export interface E2eePort {
  supported(): boolean;
  deriveRawGroupKey(subtle: SubtleCrypto, secret: string): Promise<Uint8Array>;
  create(rawKey: Uint8Array, log: LogFn): E2eeInstance;
}

export interface E2eeInstance {
  /** Both resolve true only when frames are genuinely transformed. The mesh
      advertises that answer to the peer, so an engine that cannot attach must
      never be announced as E2E. */
  secureSender(sender: RTCRtpSender): Promise<boolean>;
  secureReceiver(receiver: RTCRtpReceiver): Promise<boolean>;
  destroy(): void;
}

/** Port: Crypto operations needed by session. */
export interface CryptoPort {
  generateRoomSecret(): string;
  isValidRoomSecret(secret: string): boolean;
  normalizeRoomSecret(secret: string): string;
  parseChannelHash(hash: string): { channel: string; secret: string | null } | null;
  buildShareLink(channel: string, secret: string, origin: string, pathname: string): string;
  deriveSecretFromPassphrase(words: string, channel: string): Promise<string>;
  passphraseStrength(pass: string): { score: number; label: string };
}

/** Port: mic hardware owned by the session. The capture window itself
    belongs to the PTT gesture (mic.ts): nothing is acquired at join, so
    the session's only obligation is that a room you left holds no
    hardware. */
export interface MicPort {
  release(): void;
}

/** Port: Persistence operations. */
export interface StoragePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  getSession(key: string): string | null;
  setSession(key: string, value: string): void;
  removeSession(key: string): void;
}

/** Port: UI operations needed by session. */
export interface UiPort {
  showScreen(name: 'radio' | 'join'): void;
  showHintOnce(): void;
  joinError(msg: string): void;
  toast(msg: string): void;
  syncRadioHash(channel: string, secret: string): void;
  prefillJoin(channel: string | null): void;
  clearWords(): void;
}

/** Logging. */
export type LogFn = (msg: string, kind?: string) => void;

/** All dependencies for session-service (injected at bootstrap). */
export interface SessionDeps {
  mesh: MeshPort;
  e2ee: E2eePort;
  mic: MicPort;
  crypto: CryptoPort;
  storage: StoragePort;
  ui: UiPort;
  log: LogFn;
  config: { maxTxMs: number };
}