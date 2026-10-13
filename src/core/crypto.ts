/* ═══════════════════════════════════════════════════════════════
   core/crypto.ts — room secrets, un-enumerable peer IDs, SAS,
   E2EE group key. All async via WebCrypto (works in Node tests).

   Trust model:
   · The 2-digit channel is a DISPLAY NAME, not a credential.
   · The room SECRET (random, lives in the share link #CH.KEY)
     is the credential: peer IDs are HMAC(secret, slot), so an
     attacker who doesn't hold the secret cannot enumerate slots,
     squat IDs, or even find the room on the signaling broker.
   · SAS (short auth string) binds the secret to every leg's
     DTLS fingerprint — displayed on the LCD for OOB comparison.
   ═══════════════════════════════════════════════════════════════ */

const SUBTLE = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto unavailable');
  return c.subtle;
};

const enc = new TextEncoder();

/* Crockford base32 (no I/L/O) for human-shareable secrets */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRoomSecret(bytes = 10): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  let bits = 0, acc = 0;
  for (const b of buf) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** Normalize user-pasted secrets: trim whitespace, uppercase.
    Use before validate/store so links typed by hand still join. */
export function normalizeRoomSecret(s: unknown): string {
  return typeof s === 'string' ? s.trim().toUpperCase() : '';
}

export function isValidRoomSecret(s: unknown): s is string {
  return typeof s === 'string' && new RegExp(`^[${B32}]{10,40}$`).test(s);
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await SUBTLE().importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await SUBTLE().sign('HMAC', key, enc.encode(message));
  return new Uint8Array(mac);
}

/* PeerJS-safe ID: [A-Za-z0-9-_] only */
function toIdBytes(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += B32.charAt(b & 31) + B32.charAt((b >> 5) & 7); // 2 chars per byte: 8 input bytes → 16 chars, so slice(0, 20) never truncates
  return s.slice(0, 20);
}

/**
 * Deterministic, secret-bound peer ID for a channel slot.
 * Two clients holding only the channel number derive nothing.
 */
export async function slotPeerId(secret: string, channel: string, slot: number): Promise<string> {
  const mac = await hmac(secret.toUpperCase(), `wlk1-slot:${channel}:${slot}`);
  return 'wlk1-' + toIdBytes(mac.subarray(0, 8));
}

/** Validate that an inbound caller ID belongs to our channel/slot space. */
export async function verifyCallerId(
  secret: string, channel: string, peerId: string, knownSlots: Iterable<number>,
): Promise<number> {
  for (const slot of knownSlots) {
    if (peerId === (await slotPeerId(secret, channel, slot))) return slot;
  }
  return -1;
}

/** Reverse-map an inbound peer ID to a slot, -1 if foreign. */
export async function callerSlot(
  secret: string, channel: string, peerId: string, maxSlots: number,
): Promise<number> {
  const slots = Array.from({ length: maxSlots }, (_, i) => i);
  return verifyCallerId(secret, channel, peerId, slots);
}

/**
 * SAS — 6 chars derived from the room secret + every leg's DTLS
 * fingerprint. Peers compute the same code over the same inputs;
 * a MITM who swapped fingerprints changes the code.
 */
export async function sasCode(secret: string, fingerprints: Iterable<string>): Promise<string> {
  const mac = await hmac(
    secret.toUpperCase(),
    'wlk1-sas:' + [...fingerprints].sort().join('|'),
  );
  // 4 HMAC bytes = 32 bits → 6 full-strength 5-bit chars (same alphabet as secrets).
  return bytesToSecret(mac.subarray(0, 4)).slice(0, 6);
}

export interface ChannelHash {
  channel: string;
  secret: string | null;
}

/** Deep-link fragment parser: "#22.SECRET" → {channel, secret}. */
export function parseChannelHash(hash: string): ChannelHash | null {
  if (!hash) return null;
  const m = /^#(\d{1,2})(?:\.([A-Za-z0-9]+))?$/.exec(hash);
  if (!m) return null;
  return { channel: (m[1] ?? '').padStart(2, '0').slice(0, 2), secret: m[2] ?? null };
}

/** Build the share link for a channel+secret. */
export function buildShareLink(
  channel: string, secret: string, origin = 'https://wlk1.local/', path = '/',
): string {
  return `${origin.replace(/\/+$/, '')}${path}#${channel}.${secret}`;
}

/* ── passphrase → room secret ───────────────────────────────
   Passphrase words live in sessionStorage only. Opt-in "remember"
   persists the DERIVED secret (never the words) to localStorage. */

/** Argon2 salt binding a passphrase to one channel (never reused). */
export function passphraseSalt(channel: string): Uint8Array {
  return enc.encode(`wlk1-v1-CH${channel}`);
}

/** 10 raw bytes → 16 Crockford chars (same alphabet as room secrets). */
export function bytesToSecret(bytes: Uint8Array): string {
  let out = '';
  let bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32.charAt((acc >>> (bits - 5)) & 31); bits -= 5; }
  }
  if (bits) out += B32.charAt((acc << (5 - bits)) & 31);
  return out;
}

export async function deriveSecretFromPassphrase(pass: string, channel: string): Promise<string> {
  const norm = pass.normalize('NFKC').trim(); // case-sensitive: no lowercasing
  const salt = passphraseSalt(channel);
  // argon2id ONLY — deliberately NO PBKDF2 fallback. The two KDFs derive
  // different secrets for the same input, so a silent fallback splits rooms.
  // When the CSP blocks the wasm build this throws loudly instead.
  try {
    // DYNAMIC deep import — argon2-only UMD (~29K). The flat 'hash-wasm'
    // ESM entry ships all 21 algorithms (~216K) and defeats treeshaking.
    const { default: argon2 } = await import('hash-wasm/dist/argon2.umd.min.js');
    const raw = await argon2.argon2id({
      password: norm, salt, parallelism: 1, iterations: 2,
      memorySize: 19456, hashLength: 10, outputType: 'binary',
    });
    return bytesToSecret(raw);
  } catch {
    throw new Error('KDF UNAVAILABLE — WASM BLOCKED');
  }
}
