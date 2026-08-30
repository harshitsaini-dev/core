'use client';

import { decryptBytes, encryptBytes, importAesKey } from '@core/crypto';
import type { Bytes } from '@core/crypto';
import type { Encrypted } from '@core/shared';

/**
 * Files attached to a vault item.
 *
 * The body is encrypted under a key generated for that one file, and that key
 * is then wrapped by the Account Key. Two reasons rather than encrypting the
 * body under the Account Key directly: one leaked object is one leaked file,
 * and the thing needed to list attachments stays small — the wrapped key
 * arrives with the row, and the body is fetched from R2 only when it is opened.
 *
 * The filename and the MIME type are encrypted too. `passport-scan.pdf` is a
 * sentence about somebody, and a server that sorted a list by name would be
 * reading it.
 *
 * What the server therefore holds: ciphertext under a random object key, a
 * wrapped key it cannot unwrap, two more ciphertexts, and a size — which it
 * needs for the quota and which anybody counting bytes on the wire has anyway.
 */

const BODY_AAD = 'core.attachment.body.v1';
const NAME_AAD = 'core.attachment.name.v1';
const MIME_AAD = 'core.attachment.mime.v1';
const KEY_AAD = 'core.attachment.key.v1';

/**
 * Ten megabytes, before encryption.
 *
 * Not a storage limit — R2 gives 10 GB free. It is a limit on what a browser
 * can encrypt in one pass without the tab freezing, and on what somebody on a
 * phone can upload before deciding the app has hung. A vault is for recovery
 * codes, scans and keys; anything larger belongs somewhere built for it.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface SealedAttachment {
  /** The encrypted body, to go to R2. */
  readonly body: Bytes;
  readonly itemKeyWrapped: Encrypted;
  readonly filenameEnc: Encrypted;
  readonly mimeEnc: Encrypted;
}

export async function sealAttachment(accountKey: CryptoKey, file: File): Promise<SealedAttachment> {
  const raw = crypto.getRandomValues(new Uint8Array(32)) as Bytes;
  const fileKey = await importAesKey(raw);

  const plain = new Uint8Array(await file.arrayBuffer()) as Bytes;
  const sealed = await encryptBytes(fileKey, plain, BODY_AAD);

  return {
    body: new TextEncoder().encode(sealed) as Bytes,
    itemKeyWrapped: await encryptBytes(accountKey, raw, KEY_AAD),
    filenameEnc: await encryptBytes(
      accountKey,
      new TextEncoder().encode(file.name) as Bytes,
      NAME_AAD,
    ),
    // Empty rather than guessed. A browser that reports no type is telling the
    // truth about what it knows, and inventing one here would put a claim in
    // ciphertext that nothing checked.
    mimeEnc: await encryptBytes(accountKey, new TextEncoder().encode(file.type) as Bytes, MIME_AAD),
  };
}

export interface OpenedAttachment {
  readonly filename: string;
  readonly mime: string;
}

/** The listing half: what a file is called, without fetching it. */
export async function openAttachmentMeta(
  accountKey: CryptoKey,
  filenameEnc: string,
  mimeEnc: string,
): Promise<OpenedAttachment | null> {
  try {
    const decoder = new TextDecoder();
    return {
      filename: decoder.decode(await decryptBytes(accountKey, filenameEnc, NAME_AAD)),
      mime: decoder.decode(await decryptBytes(accountKey, mimeEnc, MIME_AAD)),
    };
  } catch {
    return null;
  }
}

/** The body half, once somebody asks for it. */
export async function openAttachmentBody(
  accountKey: CryptoKey,
  itemKeyWrapped: string,
  body: ArrayBuffer,
): Promise<Bytes | null> {
  try {
    const raw = await decryptBytes(accountKey, itemKeyWrapped, KEY_AAD);
    const fileKey = await importAesKey(raw);
    const envelope = new TextDecoder().decode(body);

    return await decryptBytes(fileKey, envelope, BODY_AAD);
  } catch {
    // A body that will not open is a body encrypted under a key this account
    // does not have, or one that was altered in transit. Both are the same
    // sentence to whoever is looking at it.
    return null;
  }
}
