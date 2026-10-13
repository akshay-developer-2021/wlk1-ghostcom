import { describe, it, expect } from 'vitest';
import {
  generateRoomSecret, isValidRoomSecret, normalizeRoomSecret, slotPeerId, callerSlot,
  sasCode, parseChannelHash, buildShareLink,
} from '../src/core/crypto.js';

describe('room secrets', () => {
  it('generates valid Crockford base32 secrets', () => {
    const s = generateRoomSecret();
    expect(s).toHaveLength(16);
    expect(isValidRoomSecret(s)).toBe(true);
    expect(isValidRoomSecret('22')).toBe(false);
    expect(isValidRoomSecret('ILEO011')).toBe(false); // forbidden I/L/O chars
  });

  it('generates unique secrets', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateRoomSecret()));
    expect(set.size).toBe(50);
  });
});

describe('slotPeerId — un-enumerable, secret-bound peer IDs', () => {
  it('is deterministic per (secret, channel, slot)', async () => {
    const a = await slotPeerId('ABC234', '22', 3);
    const b = await slotPeerId('ABC234', '22', 3);
    expect(a).toBe(b);
  });

  it('differs per slot, channel, and secret', async () => {
    const s = 'ABC234';
    expect(await slotPeerId(s, '22', 0)).not.toBe(await slotPeerId(s, '22', 1));
    expect(await slotPeerId(s, '22', 0)).not.toBe(await slotPeerId(s, '23', 0));
    expect(await slotPeerId(s, '22', 0)).not.toBe(await slotPeerId('XYZ789', '22', 0));
  });

  it('is PeerJS-ID safe and does not leak channel or slot', async () => {
    const id = await slotPeerId('ABC234', '22', 3);
    expect(id).toMatch(/^wlk1-[0-9A-Z]{16}$/);
    expect(id).not.toContain('22');
  });

  it('cannot be derived without the secret (channel is not a credential)', async () => {
    const withSecret = await slotPeerId('ABC234', '22', 0);
    const wrong = await slotPeerId('WRONGSECRETX', '22', 0);
    expect(wrong).not.toBe(withSecret);
  });
});

describe('callerSlot — inbound call authentication', () => {
  it('maps a legitimate caller to its slot', async () => {
    const s = 'ABC234';
    const id = await slotPeerId(s, '22', 5);
    expect(await callerSlot(s, '22', id, 8)).toBe(5);
  });

  it('rejects foreign IDs (wrong secret / channel / garbage)', async () => {
    const s = 'ABC234';
    const foreign = await slotPeerId('OTHERSECRET', '22', 5);
    const otherCh = await slotPeerId(s, '23', 5);
    expect(await callerSlot(s, '22', foreign, 8)).toBe(-1);
    expect(await callerSlot(s, '22', otherCh, 8)).toBe(-1);
    expect(await callerSlot(s, '22', 'wlk1-ch-22-5', 8)).toBe(-1); // legacy guessable ID
  });
});

describe('SAS — fingerprint verification code', () => {
  it('is 6 Crockford chars', async () => {
    expect(await sasCode('ABC234', ['AA:BB', 'CC:DD']))
      .toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
  });

  it('is deterministic (same inputs → same code)', async () => {
    const s = 'ABC234';
    const fps = ['AA:BB', 'CC:DD'];
    expect(await sasCode(s, [...fps])).toBe(await sasCode(s, [...fps]));
  });

  it('is order-independent (sorted legs)', async () => {
    expect(await sasCode('ABC234', ['AA:BB', 'CC:DD']))
      .toBe(await sasCode('ABC234', ['CC:DD', 'AA:BB']));
  });

  it('is tamper-sensitive (swapped fingerprint → different code)', async () => {
    const s = 'ABC234';
    const a = await sasCode(s, ['AA:BB', 'CC:DD']);
    expect(await sasCode(s, ['AA:BB', 'FF:EE'])).not.toBe(a);
  });
});

describe('deep links', () => {
  it('parses #22.KEY and bare #22', () => {
    expect(parseChannelHash('#22.ABC234DEF567')).toEqual({ channel: '22', secret: 'ABC234DEF567' });
    expect(parseChannelHash('#7')).toEqual({ channel: '07', secret: null });
    expect(parseChannelHash('')).toBeNull();
    expect(parseChannelHash('#nope!')).toBeNull();
  });

  it('share link round-trips through the parser', () => {
    const url = buildShareLink('42', 'ABC234DEF567', 'https://radio.example.com', '/app/');
    const hash = new URL(url).hash;
    expect(parseChannelHash(hash)).toEqual({ channel: '42', secret: 'ABC234DEF567' });
  });
});

describe('normalizeRoomSecret — paste-tolerant secrets', () => {
  it('trims whitespace and uppercases', () => {
    expect(normalizeRoomSecret('  abc234  ')).toBe('ABC234');
    expect(normalizeRoomSecret('AbC234')).toBe('ABC234');
    expect(normalizeRoomSecret('\tabc234\n')).toBe('ABC234');
  });

  it('non-strings normalize to empty (never throw)', () => {
    expect(normalizeRoomSecret(null)).toBe('');
    expect(normalizeRoomSecret(undefined)).toBe('');
    expect(normalizeRoomSecret(42)).toBe('');
    expect(normalizeRoomSecret({})).toBe('');
    expect(normalizeRoomSecret('')).toBe('');
  });

  it('normalized output validates when the pasted secret is legit', () => {
    expect(isValidRoomSecret(normalizeRoomSecret('  abc234def567  '))).toBe(true);
  });
});

/* NOTE: main.ts passphrase→secret KDF is owned by another stream (it will
   export the helper); KDF tests are explicitly out of scope here. */
