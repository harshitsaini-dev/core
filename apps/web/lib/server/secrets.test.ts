import { randomBytes } from '@core/crypto';
import { describe, expect, it } from 'vitest';
import {
  decoySalt,
  deriveServerKey,
  emailIndex,
  hashIp,
  hashUserAgent,
  normalizeEmail,
  parsePepper,
  serverTag,
} from './secrets';

const PEPPER = parsePepper(Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64'));

describe('parsePepper', () => {
  it('accepts standard base64, which is what the generator prints', () => {
    const raw = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
    expect(parsePepper(raw)).toHaveLength(32);
  });

  it('accepts base64url too, since people paste both', () => {
    const bytes = randomBytes(32);
    const b64url = Buffer.from(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(parsePepper(b64url)).toEqual(bytes);
  });

  it('tolerates surrounding whitespace from a copy-paste', () => {
    const raw = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
    expect(parsePepper(`  ${raw}\n`)).toHaveLength(32);
  });

  it('refuses to run without a pepper, rather than defaulting to one', () => {
    expect(() => parsePepper(undefined)).toThrow(/AUTH_PEPPER is not set/);
    expect(() => parsePepper('')).toThrow(/AUTH_PEPPER is not set/);
  });

  it('refuses a pepper that is too short to be worth having', () => {
    const short = Buffer.from(new Uint8Array(16).fill(9)).toString('base64');
    expect(() => parsePepper(short)).toThrow(/at least 32 bytes/);
  });
});

describe('deriveServerKey', () => {
  it('produces a non-extractable HMAC key', async () => {
    const key = await deriveServerKey(PEPPER, 'emailIndex');
    expect(key.algorithm.name).toBe('HMAC');
    expect(key.extractable).toBe(false);
  });

  it('separates purposes, so one derived key cannot stand in for another', async () => {
    // If these ever collided, a session-token hash would double as an email
    // index and the separation would be decorative.
    const purposes = ['emailIndex', 'decoySalt', 'ipHash', 'uaHash', 'sessionToken'] as const;
    const tags = await Promise.all(purposes.map((purpose) => serverTag(PEPPER, purpose, 'same')));
    expect(new Set(tags).size).toBe(purposes.length);
  });

  it('changes entirely with the pepper', async () => {
    const other = parsePepper(Buffer.from(randomBytes(32)).toString('base64'));
    expect(await serverTag(PEPPER, 'emailIndex', 'a@b.com')).not.toBe(
      await serverTag(other, 'emailIndex', 'a@b.com'),
    );
  });
});

describe('normalizeEmail', () => {
  it('folds case and trims', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it('strips a pasted mailto prefix', () => {
    expect(normalizeEmail('mailto:a@b.com')).toBe('a@b.com');
  });

  it('applies NFKC', () => {
    expect(normalizeEmail('ﬁle@example.com')).toBe('file@example.com');
  });
});

describe('emailIndex', () => {
  it('is stable for the same address', async () => {
    expect(await emailIndex(PEPPER, 'a@b.com')).toBe(await emailIndex(PEPPER, 'a@b.com'));
  });

  it('matches across case and whitespace, so duplicates cannot slip in', async () => {
    expect(await emailIndex(PEPPER, ' A@B.com ')).toBe(await emailIndex(PEPPER, 'a@b.com'));
  });

  it('differs for different addresses', async () => {
    expect(await emailIndex(PEPPER, 'a@b.com')).not.toBe(await emailIndex(PEPPER, 'c@d.com'));
  });

  it('reveals nothing readable of the address', async () => {
    const index = await emailIndex(PEPPER, 'harshit@example.com');
    expect(index.toLowerCase()).not.toContain('harshit');
    expect(index.toLowerCase()).not.toContain('example');
  });
});

describe('decoySalt', () => {
  it('is deterministic — asking twice must not expose that an account is fake', async () => {
    // This is the whole point. A random decoy would make enumeration trivial:
    // ask twice, compare, and a changing salt means no such account.
    const first = await decoySalt(PEPPER, 'nobody@example.com');
    const second = await decoySalt(PEPPER, 'nobody@example.com');
    expect(first).toBe(second);
  });

  it('is the same length as a real salt', async () => {
    const decoy = await decoySalt(PEPPER, 'nobody@example.com');
    expect(Buffer.from(decoy.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toHaveLength(16);
  });

  it('differs per address, so decoys are not obviously a single constant', async () => {
    const salts = await Promise.all(
      Array.from({ length: 50 }, (_, i) => decoySalt(PEPPER, `user${i}@example.com`)),
    );
    expect(new Set(salts).size).toBe(50);
  });

  it('cannot be predicted without the pepper', async () => {
    const other = parsePepper(Buffer.from(randomBytes(32)).toString('base64'));
    expect(await decoySalt(PEPPER, 'a@b.com')).not.toBe(await decoySalt(other, 'a@b.com'));
  });

  it('is not the same value as the email index for that address', async () => {
    // Different HKDF info strings, so a client cannot correlate the two.
    expect(await decoySalt(PEPPER, 'a@b.com')).not.toBe(await emailIndex(PEPPER, 'a@b.com'));
  });
});

describe('audit hashing', () => {
  it('hashes IPs rather than storing them', async () => {
    const hash = await hashIp(PEPPER, '203.0.113.42');
    expect(hash).not.toContain('203');
    expect(await hashIp(PEPPER, '203.0.113.42')).toBe(hash);
    expect(await hashIp(PEPPER, '203.0.113.43')).not.toBe(hash);
  });

  it('hashes user agents rather than storing the fingerprint', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
    const hash = await hashUserAgent(PEPPER, ua);
    expect(hash).not.toContain('Mozilla');
    expect(await hashUserAgent(PEPPER, ua)).toBe(hash);
  });
});
