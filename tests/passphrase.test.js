import { describe, it, expect } from 'vitest';
// KDF only — never main.ts (side-effectful on import).
import {
  deriveSecretFromPassphrase, bytesToSecret, passphraseSalt,
} from '../src/core/crypto.js';

const WORDS = 'correct horse battery staple';
const CROCKFORD = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/;

describe('deriveSecretFromPassphrase', () => {
  it('is deterministic (same input → same secret twice)', async () => {
    const a = await deriveSecretFromPassphrase(WORDS, '22');
    expect(a).toBe(await deriveSecretFromPassphrase(WORDS, '22'));
  });

  it('separates channels (same words, different channel → different secret)', async () => {
    expect(await deriveSecretFromPassphrase(WORDS, '22'))
      .not.toBe(await deriveSecretFromPassphrase(WORDS, '23'));
  });

  it('is case-sensitive (different case → different secret)', async () => {
    expect(await deriveSecretFromPassphrase(WORDS, '22'))
      .not.toBe(await deriveSecretFromPassphrase(WORDS.toUpperCase(), '22'));
  });

  it('treats padded input like trimmed input', async () => {
    expect(await deriveSecretFromPassphrase(`  ${WORDS}  `, '22'))
      .toBe(await deriveSecretFromPassphrase(WORDS, '22'));
  });

  // The WASM-blocked loud-failure path is unmockable here (the dynamic
  // UMD import resolves in node); assert the output shape instead.
  it('emits 16-char Crockford secrets', async () => {
    const s = await deriveSecretFromPassphrase(WORDS, '22');
    expect(s).toHaveLength(16);
    expect(s).toMatch(CROCKFORD);
  });
});

describe('passphraseSalt', () => {
  it('formats as wlk1-v1-CH<channel>', () => {
    const dec = new TextDecoder();
    expect(dec.decode(passphraseSalt('22'))).toBe('wlk1-v1-CH22');
    expect(dec.decode(passphraseSalt('07'))).toBe('wlk1-v1-CH07');
  });
});

describe('bytesToSecret', () => {
  it('maps zero bytes to zeros (10 bytes → 16 chars)', () => {
    expect(bytesToSecret(new Uint8Array(10))).toBe('0'.repeat(16));
  });
});
