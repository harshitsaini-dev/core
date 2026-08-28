import { describe, expect, it } from 'vitest';
import {
  formatDotenv,
  formatShellExport,
  isValidEnvKey,
  maskValue,
  mergeVars,
  parseDotenv,
} from './env';
import type { DecryptedEnvVar } from './env';

/**
 * The `.env` parser.
 *
 * Written rather than pulled in, because the text it reads is a file full of
 * production secrets and it runs in the origin that holds the vault keys. That
 * choice is only defensible if the parser is actually right, so this covers
 * what real files contain rather than what a happy path looks like.
 */

function variable(key: string, value: string, overrides: Partial<DecryptedEnvVar> = {}) {
  return {
    id: key,
    environmentId: 'env',
    key,
    value,
    note: null,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  } satisfies DecryptedEnvVar;
}

describe('parseDotenv', () => {
  it('reads the ordinary case', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux').vars).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
  });

  it('ignores blank lines and comments', () => {
    const text = '# a comment\n\nFOO=bar\n\n  # indented comment\nBAZ=qux\n';
    expect(parseDotenv(text).vars).toHaveLength(2);
  });

  it('accepts the export prefix, which is how people paste from a shell', () => {
    expect(parseDotenv('export FOO=bar').vars).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('keeps an empty value', () => {
    // `FOO=` is meaningful: it is set and empty, which is not the same as unset.
    expect(parseDotenv('FOO=').vars).toEqual([{ key: 'FOO', value: '' }]);
  });

  it('strips a trailing comment from an unquoted value', () => {
    expect(parseDotenv('FOO=bar # why').vars).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('keeps a hash that is part of the value', () => {
    // A `#` with no space before it is not a comment — and passwords contain
    // hashes far more often than trailing comments do.
    expect(parseDotenv('FOO=pa#ss').vars).toEqual([{ key: 'FOO', value: 'pa#ss' }]);
  });

  it('keeps a hash inside quotes', () => {
    expect(parseDotenv('FOO="bar # not a comment"').vars).toEqual([
      { key: 'FOO', value: 'bar # not a comment' },
    ]);
  });

  it('keeps spaces inside quotes and trims them outside', () => {
    expect(parseDotenv('FOO="  spaced  "').vars).toEqual([{ key: 'FOO', value: '  spaced  ' }]);
    expect(parseDotenv('FOO=  spaced  ').vars).toEqual([{ key: 'FOO', value: 'spaced' }]);
  });

  it('interprets escapes in double quotes and not in single', () => {
    expect(parseDotenv('FOO="a\\nb"').vars[0]?.value).toBe('a\nb');
    expect(parseDotenv("FOO='a\\nb'").vars[0]?.value).toBe('a\\nb');
  });

  it('reads a value that runs across lines', () => {
    // A private key pasted into a `.env` is one value across twenty lines, and
    // losing it at the first newline is the most annoying possible bug.
    const key = 'FOO="-----BEGIN KEY-----\nline two\nline three\n-----END KEY-----"';
    expect(parseDotenv(key).vars[0]?.value).toBe(
      '-----BEGIN KEY-----\nline two\nline three\n-----END KEY-----',
    );
  });

  it('carries on after a multi-line value', () => {
    const text = 'A="one\ntwo"\nB=three';
    expect(parseDotenv(text).vars).toEqual([
      { key: 'A', value: 'one\ntwo' },
      { key: 'B', value: 'three' },
    ]);
  });

  it('survives a file written on Windows', () => {
    expect(parseDotenv('FOO=bar\r\nBAZ=qux\r\n').vars).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
  });

  it('keeps an equals sign that is part of the value', () => {
    expect(parseDotenv('TOKEN=abc==').vars).toEqual([{ key: 'TOKEN', value: 'abc==' }]);
  });

  it('reports what it could not read instead of dropping it silently', () => {
    // A file that half-parses is more useful than a refusal, but only if it
    // says which half.
    const result = parseDotenv('FOO=bar\nthis is not a variable\n=novalue\n');
    expect(result.vars).toHaveLength(1);
    expect(result.skipped).toEqual(['this is not a variable', '=novalue']);
  });

  it('skips a key a shell could not accept', () => {
    expect(parseDotenv('9LIVES=cat\nMY-KEY=x').skipped).toHaveLength(2);
  });

  it('takes what it can from an unterminated quote', () => {
    expect(parseDotenv('FOO="unterminated').vars).toEqual([{ key: 'FOO', value: 'unterminated' }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseDotenv('').vars).toEqual([]);
    expect(parseDotenv('\n\n\n').vars).toEqual([]);
  });
});

describe('formatDotenv', () => {
  it('writes the simple case unquoted', () => {
    expect(formatDotenv([{ key: 'FOO', value: 'bar' }])).toBe('FOO=bar\n');
  });

  it('quotes anything that would not survive otherwise', () => {
    expect(formatDotenv([{ key: 'FOO', value: 'a b' }])).toBe('FOO="a b"\n');
    expect(formatDotenv([{ key: 'FOO', value: '' }])).toBe('FOO=""\n');
    expect(formatDotenv([{ key: 'FOO', value: 'a#b' }])).toBe('FOO="a#b"\n');
  });

  it('round-trips everything the parser can read', () => {
    const cases = [
      'plain',
      '',
      'with space',
      'with "quotes"',
      "single 'quotes'",
      'hash # inside',
      'new\nline',
      'tab\there',
      'back\\slash',
      'dollar $sign',
      'equals=sign',
    ];

    for (const value of cases) {
      const written = formatDotenv([{ key: 'K', value }]);
      const read = parseDotenv(written).vars[0];
      expect(read, `lost the variable for ${JSON.stringify(value)}`).toBeDefined();
      expect(read?.value, `round trip changed ${JSON.stringify(value)}`).toBe(value);
    }
  });
});

describe('formatShellExport', () => {
  it('is pasteable into a terminal', () => {
    expect(formatShellExport([{ key: 'FOO', value: 'a b' }])).toBe('export FOO="a b"\n');
  });
});

describe('mergeVars', () => {
  it('adds what is new', () => {
    const result = mergeVars([variable('A', '1')], [{ key: 'B', value: '2' }]);
    expect(result.added).toEqual([{ key: 'B', value: '2' }]);
    expect(result.updated).toEqual([]);
  });

  it('updates what changed', () => {
    const result = mergeVars([variable('A', '1')], [{ key: 'A', value: '2' }]);
    expect(result.updated).toEqual([{ id: 'A', value: '2' }]);
  });

  it('leaves an unchanged variable alone', () => {
    const result = mergeVars([variable('A', '1')], [{ key: 'A', value: '1' }]);
    expect(result.updated).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it('never removes what the import did not mention', () => {
    // "Add the two new keys from staging" must not mean "lose everything else",
    // and the person doing it would not find out until a deploy failed.
    const result = mergeVars([variable('KEEP', '1')], [{ key: 'NEW', value: '2' }]);
    expect(result.added).toEqual([{ key: 'NEW', value: '2' }]);
    expect(JSON.stringify(result)).not.toContain('KEEP');
  });

  it('treats a deleted variable as absent', () => {
    const result = mergeVars([variable('A', '1', { deletedAt: 1 })], [{ key: 'A', value: '2' }]);
    expect(result.added).toEqual([{ key: 'A', value: '2' }]);
    expect(result.updated).toEqual([]);
  });
});

describe('maskValue', () => {
  it('shows the last four, which is how people recognise a key', () => {
    expect(maskValue('sk_live_abcd1234')).toMatch(/1234$/);
    expect(maskValue('sk_live_abcd1234')).not.toContain('sk_live');
  });

  it('reveals nothing of a short value', () => {
    expect(maskValue('abcd')).toBe('••••');
    expect(maskValue('a')).toBe('•');
  });

  it('does not leak the length of a long value', () => {
    const short = maskValue('x'.repeat(40));
    const long = maskValue('x'.repeat(400));
    expect(short).toBe(long);
  });

  it('shows something for an empty value', () => {
    expect(maskValue('')).toBe('•');
  });
});

describe('isValidEnvKey', () => {
  it('accepts what a shell accepts', () => {
    for (const key of ['FOO', '_FOO', 'FOO_BAR', 'a1']) {
      expect(isValidEnvKey(key), key).toBe(true);
    }
  });

  it('rejects what a shell would not source', () => {
    for (const key of ['9LIVES', 'MY-KEY', 'MY KEY', '', 'MY.KEY', 'MY$KEY']) {
      expect(isValidEnvKey(key), key).toBe(false);
    }
  });
});
