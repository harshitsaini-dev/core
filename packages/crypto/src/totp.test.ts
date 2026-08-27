import { describe, expect, it } from 'vitest';
import { bytesToHex, utf8ToBytes } from './encoding.js';
import { base32Decode, hotp, parseOtpauth, secondsRemaining, totp } from './totp.js';

/**
 * Checked against the published vectors in RFC 4226 and RFC 6238.
 *
 * These matter more than usual. A TOTP implementation that is subtly wrong
 * still produces six plausible digits, and the only symptom is that codes are
 * rejected by a service the user cannot debug. Self-consistency proves nothing
 * here; agreement with the specification is the whole test.
 */

/** RFC 4226 appendix D uses this ASCII secret throughout. */
const RFC4226_SECRET = utf8ToBytes('12345678901234567890');

/** RFC 6238 appendix B, one seed per algorithm. */
const RFC6238_SHA1 = utf8ToBytes('12345678901234567890');
const RFC6238_SHA256 = utf8ToBytes('12345678901234567890123456789012');
const RFC6238_SHA512 = utf8ToBytes(
  '1234567890123456789012345678901234567890123456789012345678901234',
);

describe('base32Decode', () => {
  it('decodes the canonical example', () => {
    // RFC 4648: "JBSWY3DPEHPK3PXP" is "Hello!\xDE\xAD\xBE\xEF".
    expect(bytesToHex(base32Decode('JBSWY3DPEHPK3PXP'))).toBe('48656c6c6f21deadbeef');
  });

  it('accepts a secret formatted the way setup screens print it', () => {
    // Spaces, lowercase and padding are all normal in a value somebody copied
    // off a page or typed from a photograph.
    const canonical = bytesToHex(base32Decode('JBSWY3DPEHPK3PXP'));

    expect(bytesToHex(base32Decode('jbswy3dp ehpk3pxp'))).toBe(canonical);
    expect(bytesToHex(base32Decode('JBSW-Y3DP-EHPK-3PXP'))).toBe(canonical);
    expect(bytesToHex(base32Decode('JBSWY3DPEHPK3PXP===='))).toBe(canonical);
  });

  it('rejects characters outside the alphabet', () => {
    // 0, 1 and 8 are excluded from base32 precisely because they are confusable.
    expect(() => base32Decode('JBSWY3DP0')).toThrow(TypeError);
    expect(() => base32Decode('JBSWY3DP1')).toThrow(TypeError);
    expect(() => base32Decode('')).toThrow(TypeError);
  });
});

describe('hotp — RFC 4226 appendix D', () => {
  const EXPECTED = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it.each(EXPECTED.map((code, counter) => [counter, code]))(
    'counter %i produces %s',
    async (counter, expected) => {
      expect(await hotp(RFC4226_SECRET, counter as number)).toBe(expected);
    },
  );
});

describe('totp — RFC 6238 appendix B', () => {
  // The RFC prints eight-digit codes; real deployments almost always use six.
  const OPTIONS = { digits: 8 } as const;

  const CASES = [
    { seconds: 59, sha1: '94287082', sha256: '46119246', sha512: '90693936' },
    { seconds: 1_111_111_109, sha1: '07081804', sha256: '68084774', sha512: '25091201' },
    { seconds: 1_111_111_111, sha1: '14050471', sha256: '67062674', sha512: '99943326' },
    { seconds: 1_234_567_890, sha1: '89005924', sha256: '91819424', sha512: '93441116' },
    { seconds: 2_000_000_000, sha1: '69279037', sha256: '90698825', sha512: '38618901' },
    // Past 2^31 seconds, which is where a 32-bit counter would break.
    { seconds: 20_000_000_000, sha1: '65353130', sha256: '77737706', sha512: '47863826' },
  ];

  it.each(CASES)('SHA-1 at $seconds', async ({ seconds, sha1 }) => {
    expect(await totp(RFC6238_SHA1, seconds * 1000, OPTIONS)).toBe(sha1);
  });

  it.each(CASES)('SHA-256 at $seconds', async ({ seconds, sha256 }) => {
    expect(await totp(RFC6238_SHA256, seconds * 1000, { ...OPTIONS, algorithm: 'SHA-256' })).toBe(
      sha256,
    );
  });

  it.each(CASES)('SHA-512 at $seconds', async ({ seconds, sha512 }) => {
    expect(await totp(RFC6238_SHA512, seconds * 1000, { ...OPTIONS, algorithm: 'SHA-512' })).toBe(
      sha512,
    );
  });
});

describe('totp behaviour', () => {
  it('accepts a base32 string as well as raw bytes', async () => {
    const fromString = await totp('JBSWY3DPEHPK3PXP', 60_000);
    const fromBytes = await totp(base32Decode('JBSWY3DPEHPK3PXP'), 60_000);
    expect(fromString).toBe(fromBytes);
  });

  it('holds the same code for the whole period, then changes', async () => {
    // Aligned to a period boundary. An arbitrary timestamp lands mid-period,
    // so "start plus almost a period" crosses into the next one and the test
    // fails on its own arithmetic rather than on the code.
    const period = 30_000;
    const start = Math.floor(1_700_000_000_000 / period) * period;

    const first = await totp(RFC6238_SHA1, start);
    expect(await totp(RFC6238_SHA1, start + period - 1)).toBe(first);
    expect(await totp(RFC6238_SHA1, start + period)).not.toBe(first);
  });

  it('defaults to six digits', async () => {
    expect(await totp(RFC6238_SHA1, 59_000)).toHaveLength(6);
  });

  it('pads a short code rather than dropping a digit', async () => {
    // One code in ten begins with a zero, and a service comparing strings
    // rejects a five-digit one.
    const codes = await Promise.all(
      Array.from({ length: 200 }, (_, index) => totp(RFC6238_SHA1, index * 30_000)),
    );
    expect(codes.every((code) => code.length === 6)).toBe(true);
  });
});

describe('secondsRemaining', () => {
  it('counts down within the period', () => {
    expect(secondsRemaining(0)).toBe(30);
    expect(secondsRemaining(1000)).toBe(29);
    expect(secondsRemaining(29_000)).toBe(1);
    expect(secondsRemaining(30_000)).toBe(30);
  });

  it('never returns zero, so the ring is never shown as empty', () => {
    for (let ms = 0; ms < 120_000; ms += 137) {
      expect(secondsRemaining(ms)).toBeGreaterThan(0);
    }
  });
});

describe('parseOtpauth', () => {
  it('reads a standard setup URI', () => {
    const parsed = parseOtpauth(
      'otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    );

    expect(parsed?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed?.options.digits).toBe(6);
    expect(parsed?.options.period).toBe(30);
    expect(parsed?.options.algorithm).toBe('SHA-1');
  });

  it('honours non-default parameters', () => {
    const parsed = parseOtpauth(
      'otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256',
    );

    expect(parsed?.options.digits).toBe(8);
    expect(parsed?.options.period).toBe(60);
    expect(parsed?.options.algorithm).toBe('SHA-256');
  });

  it('returns null rather than throwing on anything unusable', () => {
    // A pasted URI is ordinary user input; being wrong is not exceptional.
    for (const uri of [
      'not a uri',
      'https://example.com',
      'otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP',
      'otpauth://totp/X',
      'otpauth://totp/X?secret=not-base32-!!',
      'otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&digits=99',
      'otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&period=0',
    ]) {
      expect(parseOtpauth(uri), uri).toBeNull();
    }
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(parseOtpauth('  otpauth://totp/X?secret=JBSWY3DPEHPK3PXP  ')).not.toBeNull();
  });
});
