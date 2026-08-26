import { describe, expect, it } from 'vitest';
import {
  blindIndex,
  blindIndexEmail,
  blindIndexUrl,
  normalizeEmail,
  normalizeForIndex,
  normalizeUrl,
} from './blind-index.js';
import { base64UrlToBytes } from './encoding.js';
import { randomBytes } from './random.js';

async function hmacKey(raw = randomBytes(32)): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

describe('normalisation', () => {
  it('folds case and trims whitespace', () => {
    expect(normalizeForIndex('  GitHub  ')).toBe('github');
  });

  it('applies NFKC so compatibility forms match', () => {
    expect(normalizeForIndex('ﬁle')).toBe(normalizeForIndex('file'));
  });

  it('strips a pasted mailto prefix from emails', () => {
    expect(normalizeEmail('mailto:User@Example.COM')).toBe('user@example.com');
  });

  it('reduces urls to a bare host', () => {
    expect(normalizeUrl('https://github.com/login?next=/')).toBe('github.com');
    expect(normalizeUrl('github.com')).toBe('github.com');
    expect(normalizeUrl('https://www.github.com')).toBe('github.com');
    expect(normalizeUrl('HTTP://GitHub.com/')).toBe('github.com');
  });

  it('falls back gracefully rather than throwing on junk input', () => {
    expect(normalizeUrl('not a url at all')).toBe('not a url at all');
    expect(normalizeUrl('')).toBe('');
  });
});

describe('blindIndex', () => {
  it('is deterministic for the same key and value', async () => {
    const key = await hmacKey();
    expect(await blindIndex(key, 'github.com')).toBe(await blindIndex(key, 'github.com'));
  });

  it('matches across case and whitespace differences', async () => {
    const key = await hmacKey();
    expect(await blindIndex(key, '  GitHub.COM ')).toBe(await blindIndex(key, 'github.com'));
  });

  it('differs for different values', async () => {
    const key = await hmacKey();
    expect(await blindIndex(key, 'github.com')).not.toBe(await blindIndex(key, 'gitlab.com'));
  });

  it('differs across users, so tags cannot be correlated between accounts', async () => {
    // This is the property that stops the server building a cross-user index of
    // who banks where.
    const a = await hmacKey();
    const b = await hmacKey();
    expect(await blindIndex(a, 'github.com')).not.toBe(await blindIndex(b, 'github.com'));
  });

  it('produces a 16-byte tag', async () => {
    const tag = await blindIndex(await hmacKey(), 'anything');
    expect(base64UrlToBytes(tag)).toHaveLength(16);
  });

  it('reveals nothing recognisable of the input', async () => {
    const tag = await blindIndex(await hmacKey(), 'github.com');
    expect(tag.toLowerCase()).not.toContain('github');
  });

  it('has no collisions across a few thousand realistic values', async () => {
    const key = await hmacKey();
    const tags = await Promise.all(
      Array.from({ length: 2000 }, (_, i) => blindIndex(key, `service-${i}.example.com`)),
    );
    expect(new Set(tags).size).toBe(2000);
  });
});

describe('typed helpers', () => {
  it('indexes emails through email normalisation', async () => {
    const key = await hmacKey();
    expect(await blindIndexEmail(key, 'User@Example.com')).toBe(
      await blindIndexEmail(key, 'user@example.com'),
    );
  });

  it('indexes urls by host, so paths do not fragment the index', async () => {
    const key = await hmacKey();
    expect(await blindIndexUrl(key, 'https://github.com/settings/keys')).toBe(
      await blindIndexUrl(key, 'https://github.com/login'),
    );
  });

  it('keeps different hosts apart', async () => {
    const key = await hmacKey();
    expect(await blindIndexUrl(key, 'https://github.com')).not.toBe(
      await blindIndexUrl(key, 'https://gitlab.com'),
    );
  });
});
