import { describe, expect, it } from 'vitest';
import { openShare, sealShare } from './share';

/**
 * Share links.
 *
 * The property under test is the one the whole design rests on: what goes to
 * the server and what stays in the fragment are different things, and the first
 * is useless without the second.
 */

describe('sealShare', () => {
  it('round-trips', async () => {
    const sealed = await sealShare('hunter2');
    expect(await openShare(sealed.payload, sealed.key)).toBe('hunter2');
  });

  it('does not put the secret in what the server receives', async () => {
    const sealed = await sealShare('hunter2');
    expect(sealed.payload).not.toContain('hunter2');
  });

  it('does not put the key in what the server receives', async () => {
    // The entire point. If the key ever appeared in the payload, the server
    // would hold both halves and the link would be theatre.
    const sealed = await sealShare('hunter2');
    expect(sealed.payload).not.toContain(sealed.key);
  });

  it('uses a different key every time', async () => {
    // Deriving from the vault would tie every share ever made to one key.
    const first = await sealShare('same text');
    const second = await sealShare('same text');

    expect(first.key).not.toBe(second.key);
    expect(first.payload).not.toBe(second.payload);
  });

  it('will not open with another share’s key', async () => {
    const first = await sealShare('hunter2');
    const second = await sealShare('something else');

    expect(await openShare(first.payload, second.key)).toBeNull();
  });

  it('refuses a payload that was altered', async () => {
    // AES-GCM with AAD: a flipped byte fails authentication rather than
    // decrypting to something plausible.
    const sealed = await sealShare('hunter2');
    const bytes = [...sealed.payload];
    const last = bytes.length - 1;
    bytes[last] = bytes[last] === 'A' ? 'B' : 'A';

    expect(await openShare(bytes.join(''), sealed.key)).toBeNull();
  });

  it('says nothing useful about a truncated link', async () => {
    const sealed = await sealShare('hunter2');
    expect(await openShare(sealed.payload.slice(0, 8), sealed.key)).toBeNull();
    expect(await openShare(sealed.payload, 'not-a-key')).toBeNull();
    expect(await openShare('', '')).toBeNull();
  });
});
