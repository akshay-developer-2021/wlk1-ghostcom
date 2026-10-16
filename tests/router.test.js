import { describe, it, expect } from 'vitest';
import { parseHash } from '../src/app/router/router.js';
import { generateRoomSecret } from '../src/domain/crypto/crypto.js';

describe('parseHash', () => {
  it('routes a generated share link to the radio', () => {
    /* secrets use Crockford base32 incl. 0/1/8/9 — every one must route */
    for (let i = 0; i < 200; i++) {
      const secret = generateRoomSecret();
      expect(parseHash(`#22.${secret}`)).toEqual({ type: 'radio', channel: '22', secret });
    }
  });

  it('routes hand-typed secrets case-insensitively', () => {
    expect(parseHash('#22.abcdefgh01234567')).toEqual({
      type: 'radio', channel: '22', secret: 'ABCDEFGH01234567',
    });
  });

  it('falls back to join mode for junk secrets, keeping the channel', () => {
    expect(parseHash('#22.not-a-secret')).toEqual({ type: 'join', channel: '22' });
  });

  it('routes settings, explicit join and bare hashes', () => {
    expect(parseHash('#settings')).toEqual({ type: 'settings' });
    expect(parseHash('#settings?x=1')).toEqual({ type: 'settings' });
    expect(parseHash('#c=7')).toEqual({ type: 'join', channel: '07' });
    expect(parseHash('#7')).toEqual({ type: 'join', channel: '07' });
    expect(parseHash('#')).toEqual({ type: 'join' });
    expect(parseHash('')).toEqual({ type: 'join' });
    expect(parseHash('#22.')).toEqual({ type: 'join', channel: '22' });
  });
});