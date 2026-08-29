import type { Bytes } from './encoding.js';
import { base32Encode } from './totp.js';

/**
 * Reading Google Authenticator's export.
 *
 * "Transfer accounts" produces one or more QR codes holding
 * `otpauth-migration://offline?data=<base64 protobuf>`. There is no public
 * specification; the schema below is the one the Android app emits, and it has
 * been stable for years.
 *
 * Parsed by hand rather than by adding a protobuf runtime. The payload has two
 * message types and seven fields between them, all of which are varints,
 * length-delimited bytes, or strings — about a hundred lines of wire format
 * against a library, a code generator and a build step, for a screen somebody
 * uses once. The same reasoning as `totp.ts` next door.
 *
 * What this deliberately does not do is trust the input. Every length is
 * checked against what is left, every field is optional, and an unknown field
 * is skipped rather than assumed. The bytes come from a photograph of a screen
 * in somebody's hand, which is to say from anywhere.
 */

/** One account, in the shape the vault stores it. */
export interface MigratedAccount {
  /** Base32, as every other part of this codebase expects a TOTP secret. */
  readonly secret: string;
  /** Usually `Issuer:account@example.com`, sometimes just an address. */
  readonly name: string;
  readonly issuer: string;
  readonly digits: number;
  readonly algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
  /** Counter-based entries exist and this app does not generate them. */
  readonly type: 'totp' | 'hotp';
}

/** A cursor over the wire format, which refuses to read past its own end. */
class Reader {
  private offset = 0;

  constructor(private readonly bytes: Bytes) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;

    while (!this.done) {
      const byte = this.bytes[this.offset++] as number;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;

      shift += 7;
      // Ten groups of seven bits is more than a 64-bit varint can hold, so
      // anything longer is malformed rather than large.
      if (shift > 63) throw new RangeError('varint too long');
    }

    throw new RangeError('varint ran off the end');
  }

  bytesField(): Bytes {
    const length = this.varint();
    if (length > this.bytes.length - this.offset) {
      throw new RangeError('length field points past the end');
    }

    const slice = this.bytes.slice(this.offset, this.offset + length) as Bytes;
    this.offset += length;
    return slice;
  }

  /** Step over a field this parser does not know, keeping the cursor valid. */
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.bytesField();
    else if (wireType === 5) this.offset += 4;
    else if (wireType === 1) this.offset += 8;
    else throw new RangeError(`unknown wire type ${wireType}`);
  }
}

const ALGORITHMS = ['SHA-1', 'SHA-1', 'SHA-256', 'SHA-512', 'SHA-1'] as const;

function readAccount(bytes: Bytes): MigratedAccount | null {
  const reader = new Reader(bytes);

  let secret: Bytes | null = null;
  let name = '';
  let issuer = '';
  let algorithm: MigratedAccount['algorithm'] = 'SHA-1';
  let digits = 6;
  let type: MigratedAccount['type'] = 'totp';

  const text = new TextDecoder();

  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 7;

    if (field === 1 && wire === 2) secret = reader.bytesField();
    else if (field === 2 && wire === 2) name = text.decode(reader.bytesField());
    else if (field === 3 && wire === 2) issuer = text.decode(reader.bytesField());
    else if (field === 4 && wire === 0) algorithm = ALGORITHMS[reader.varint()] ?? 'SHA-1';
    else if (field === 5 && wire === 0) digits = reader.varint() === 2 ? 8 : 6;
    else if (field === 6 && wire === 0) type = reader.varint() === 1 ? 'hotp' : 'totp';
    else reader.skip(wire);
  }

  // An entry with no secret is not an account. Dropped rather than imported as
  // one that can never produce a code.
  if (!secret || secret.length === 0) return null;

  return { secret: base32Encode(secret), name, issuer, algorithm, digits, type };
}

/**
 * Every account in one migration URI.
 *
 * Returns an empty list rather than throwing on anything unreadable: this runs
 * on a QR code from a camera, where a partial read is ordinary, and "nothing
 * found, try again" is the honest answer to one.
 */
export function parseGoogleMigration(uri: string): MigratedAccount[] {
  let data: string | null = null;

  try {
    const parsed = new URL(uri.trim());
    if (parsed.protocol !== 'otpauth-migration:') return [];
    data = parsed.searchParams.get('data');
  } catch {
    return [];
  }

  if (!data) return [];

  try {
    // A space is not base64, and there is exactly one way it gets here: the
    // `data` param was written with a literal `+` rather than `%2B`, and URL
    // parsing turned it into a space. Google percent-encodes its own export, so
    // the common path never hits this — but a URI that has been through
    // anything that decoded it once arrives with spaces, and `atob` then throws
    // on the whole thing. The failure looks like "that is not a Google export",
    // which is a lie about a payload that is perfectly readable.
    const normalised = data.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalised);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)) as Bytes;

    const reader = new Reader(bytes);
    const accounts: MigratedAccount[] = [];

    while (!reader.done) {
      const tag = reader.varint();
      const field = tag >> 3;
      const wire = tag & 7;

      if (field === 1 && wire === 2) {
        const account = readAccount(reader.bytesField());
        if (account) accounts.push(account);
      } else {
        // Version, batch size, batch index, batch id. Real fields, and none of
        // them changes what gets imported from the batch in hand.
        reader.skip(wire);
      }
    }

    return accounts;
  } catch {
    return [];
  }
}
