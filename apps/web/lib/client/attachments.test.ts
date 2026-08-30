import { importAesKey } from '@core/crypto';
import type { Bytes } from '@core/crypto';
import { describe, expect, it } from 'vitest';
import { openAttachmentBody, openAttachmentMeta, sealAttachment } from './attachments';

/**
 * Attachments.
 *
 * The property under test is that the server can be handed all four pieces and
 * still hold nothing: the body is under a key it cannot unwrap, and the name it
 * would sort by is ciphertext.
 */

async function key(seed = 7): Promise<CryptoKey> {
  return importAesKey(new Uint8Array(32).fill(seed) as Bytes);
}

function file(name: string, text: string, type = 'application/pdf'): File {
  return new File([text], name, { type });
}

describe('sealAttachment', () => {
  it('round-trips the body and the name', async () => {
    const account = await key();
    const sealed = await sealAttachment(account, file('passport.pdf', 'the contents'));

    const meta = await openAttachmentMeta(account, sealed.filenameEnc, sealed.mimeEnc);
    expect(meta).toEqual({ filename: 'passport.pdf', mime: 'application/pdf' });

    const body = await openAttachmentBody(
      account,
      sealed.itemKeyWrapped,
      sealed.body.buffer as ArrayBuffer,
    );
    expect(new TextDecoder().decode(body as Bytes)).toBe('the contents');
  });

  it('puts neither the contents nor the name in what leaves the browser', async () => {
    const account = await key();
    const sealed = await sealAttachment(account, file('passport-scan.pdf', 'birth certificate'));

    const wire = [
      new TextDecoder().decode(sealed.body),
      sealed.filenameEnc,
      sealed.mimeEnc,
      sealed.itemKeyWrapped,
    ].join(' ');

    expect(wire).not.toContain('birth certificate');
    expect(wire).not.toContain('passport-scan');
    expect(wire).not.toContain('application/pdf');
  });

  it('uses a different key for every file', async () => {
    // One leaked object should be one leaked file.
    const account = await key();
    const first = await sealAttachment(account, file('a.pdf', 'same'));
    const second = await sealAttachment(account, file('b.pdf', 'same'));

    expect(first.itemKeyWrapped).not.toBe(second.itemKeyWrapped);
    expect(new TextDecoder().decode(first.body)).not.toBe(new TextDecoder().decode(second.body));
  });

  it('will not open with another account’s key', async () => {
    const sealed = await sealAttachment(await key(1), file('a.pdf', 'secret'));
    const stranger = await key(2);

    expect(await openAttachmentMeta(stranger, sealed.filenameEnc, sealed.mimeEnc)).toBeNull();
    expect(
      await openAttachmentBody(stranger, sealed.itemKeyWrapped, sealed.body.buffer as ArrayBuffer),
    ).toBeNull();
  });

  it('refuses a body that was altered on the way back', async () => {
    // The bytes sit in a bucket. AES-GCM means a change there fails to open
    // rather than decrypting to something else.
    const account = await key();
    const sealed = await sealAttachment(account, file('a.pdf', 'secret'));

    const bytes = new Uint8Array(sealed.body);
    const last = bytes.length - 1;
    bytes[last] = ((bytes[last] ?? 0) ^ 0xff) & 0xff;

    expect(
      await openAttachmentBody(account, sealed.itemKeyWrapped, bytes.buffer as ArrayBuffer),
    ).toBeNull();
  });

  it('keeps an empty mime type empty rather than inventing one', async () => {
    // A browser that reports no type is telling the truth about what it knows.
    const account = await key();
    const sealed = await sealAttachment(account, file('unknown.bin', 'x', ''));

    const meta = await openAttachmentMeta(account, sealed.filenameEnc, sealed.mimeEnc);
    expect(meta?.mime).toBe('');
  });
});
