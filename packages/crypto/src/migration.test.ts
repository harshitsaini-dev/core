import { describe, expect, it } from 'vitest';
import { parseGoogleMigration } from './migration';
import { base32Decode, base32Encode, totp } from './totp';

/**
 * Reading Google Authenticator's export.
 *
 * The payload is a protobuf parsed by hand, so the tests are mostly about the
 * parser refusing to trust what it is given: the bytes come from a photograph
 * of a screen in somebody's hand, which is to say from anywhere. A length that
 * points past the end, a truncated varint, a field nobody has seen before —
 * none of those may throw out of this function, because it runs on a camera
 * frame where a partial read is ordinary.
 *
 * The fixtures are built here rather than pasted from a real export. A real one
 * would be somebody's actual 2FA secrets, in a public repository, forever.
 */

/** Build a protobuf varint. */
function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;

  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);

  return out;
}

function field(number: number, wire: number): number[] {
  return varint((number << 3) | wire);
}

function lengthDelimited(number: number, payload: number[]): number[] {
  return [...field(number, 2), ...varint(payload.length), ...payload];
}

function account(options: {
  secret: number[];
  name?: string;
  issuer?: string;
  algorithm?: number;
  digits?: number;
  type?: number;
}): number[] {
  const text = (value: string): number[] => [...new TextEncoder().encode(value)];

  return [
    ...lengthDelimited(1, options.secret),
    ...(options.name ? lengthDelimited(2, text(options.name)) : []),
    ...(options.issuer ? lengthDelimited(3, text(options.issuer)) : []),
    ...(options.algorithm ? [...field(4, 0), ...varint(options.algorithm)] : []),
    ...(options.digits ? [...field(5, 0), ...varint(options.digits)] : []),
    ...(options.type ? [...field(6, 0), ...varint(options.type)] : []),
  ];
}

function migrationUri(accounts: number[][], trailing: number[] = []): string {
  const payload = [...accounts.flatMap((entry) => lengthDelimited(1, entry)), ...trailing];
  const base64 = btoa(String.fromCharCode(...payload));
  return `otpauth-migration://offline?data=${encodeURIComponent(base64)}`;
}

const SECRET = [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef];

describe('parseGoogleMigration', () => {
  it('reads an account back out', () => {
    const uri = migrationUri([
      account({ secret: SECRET, name: 'GitHub:me@example.com', issuer: 'GitHub' }),
    ]);

    const [entry] = parseGoogleMigration(uri);

    expect(entry?.name).toBe('GitHub:me@example.com');
    expect(entry?.issuer).toBe('GitHub');
    expect(base32Decode(entry?.secret ?? '')).toEqual(new Uint8Array(SECRET));
  });

  it('reads every account in one code', () => {
    const uri = migrationUri([
      account({ secret: SECRET, issuer: 'One' }),
      account({ secret: SECRET, issuer: 'Two' }),
      account({ secret: SECRET, issuer: 'Three' }),
    ]);

    expect(parseGoogleMigration(uri).map((entry) => entry.issuer)).toEqual(['One', 'Two', 'Three']);
  });

  it('produces a secret that actually generates codes', async () => {
    // The whole point of the import. A secret that round-trips through base32
    // but cannot drive the generator would be a silent, useless import.
    const uri = migrationUri([account({ secret: SECRET })]);
    const [entry] = parseGoogleMigration(uri);

    const code = await totp(entry?.secret ?? '', 0);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('carries the digits and algorithm across', () => {
    const uri = migrationUri([account({ secret: SECRET, algorithm: 3, digits: 2 })]);

    const [entry] = parseGoogleMigration(uri);
    expect(entry?.algorithm).toBe('SHA-512');
    expect(entry?.digits).toBe(8);
  });

  it('marks counter-based entries as what they are', () => {
    // This app does not generate HOTP. Importing one silently as a TOTP would
    // produce codes that are always wrong.
    const uri = migrationUri([account({ secret: SECRET, type: 1 })]);
    expect(parseGoogleMigration(uri)[0]?.type).toBe('hotp');
  });

  it('skips a field it has never seen', () => {
    // Google has added fields before. An unknown one must be stepped over, not
    // treated as the end of the message.
    const withUnknown = [
      ...account({ secret: SECRET, issuer: 'Kept' }),
      ...field(9, 0),
      ...varint(1234),
    ];

    expect(parseGoogleMigration(migrationUri([withUnknown]))[0]?.issuer).toBe('Kept');
  });

  it('returns nothing for anything that is not a migration URI', () => {
    expect(parseGoogleMigration('https://example.com')).toEqual([]);
    expect(parseGoogleMigration('otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP')).toEqual([]);
    expect(parseGoogleMigration('not a url at all')).toEqual([]);
    expect(parseGoogleMigration('otpauth-migration://offline')).toEqual([]);
  });

  it('survives a payload that lies about its own lengths', () => {
    // A length pointing past the end is what a truncated camera read looks
    // like. It must come back empty rather than throwing into the UI.
    const lying = [...field(1, 2), ...varint(200), 0x01, 0x02];
    const base64 = btoa(String.fromCharCode(...lying));

    expect(parseGoogleMigration(`otpauth-migration://offline?data=${base64}`)).toEqual([]);
  });

  it('survives a truncated varint', () => {
    const truncated = [0x80, 0x80, 0x80];
    const base64 = btoa(String.fromCharCode(...truncated));

    expect(parseGoogleMigration(`otpauth-migration://offline?data=${base64}`)).toEqual([]);
  });

  it('drops an entry with no secret rather than importing a dead one', () => {
    const uri = migrationUri([
      [...lengthDelimited(2, [...new TextEncoder().encode('No secret')])],
      account({ secret: SECRET, issuer: 'Real' }),
    ]);

    expect(parseGoogleMigration(uri).map((entry) => entry.issuer)).toEqual(['Real']);
  });
});

describe('parseGoogleMigration and the URI it arrives in', () => {
  /**
   * The payload is standard base64, so it contains `+`. Written into a query
   * string without percent-encoding, URL parsing turns that `+` into a space
   * and `atob` throws on the whole string — an export that reads perfectly
   * being reported as not an export at all.
   */
  it('reads a data param whose plus signs were never encoded', () => {
    // A secret chosen so its base64 contains a `+`, which is the only way this
    // test can fail for the right reason.
    const secret = [0xfb, 0x1e, 0x7f, 0xa0, 0x3e, 0xc1, 0xff, 0x0e, 0x7f, 0xb0];
    const payload = lengthDelimited(1, account({ secret, name: 'Site:me', issuer: 'Site' }));
    const base64 = btoa(String.fromCharCode(...payload));
    expect(base64, 'the fixture must contain a plus to test anything').toContain('+');

    const encoded = parseGoogleMigration(
      `otpauth-migration://offline?data=${encodeURIComponent(base64)}`,
    );
    const raw = parseGoogleMigration(`otpauth-migration://offline?data=${base64}`);

    expect(encoded).toHaveLength(1);
    expect(raw).toEqual(encoded);
  });
});

describe('base32Encode', () => {
  it('round-trips through the decoder', () => {
    for (const length of [1, 2, 5, 10, 20, 32]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37) % 256);
      expect(base32Decode(base32Encode(bytes as never))).toEqual(bytes);
    }
  });

  it('pads, because some services refuse a secret that is not padded', () => {
    expect(base32Encode(new Uint8Array([1]) as never)).toMatch(/=+$/);
  });
});
