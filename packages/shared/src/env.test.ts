import { describe, expect, it } from 'vitest';
import {
  formatDotenv,
  formatShellExport,
  isValidEnvKey,
  maskValue,
  mergeVars,
  parseDotenv,
  valueProblem,
  formatDockerArgs,
  formatComposeEnv,
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

describe('comments', () => {
  it('attaches a comment to the variable beneath it', () => {
    // A `#` line in a `.env` almost always documents what follows, and that is
    // the same thing a per-variable note is.
    const result = parseDotenv('# Used by the billing job only.\nTOKEN=abc');
    expect(result.vars[0]?.note).toBe('Used by the billing job only.');
  });

  it('joins consecutive comment lines', () => {
    const result = parseDotenv('# First line.\n# Second line.\nTOKEN=abc');
    expect(result.vars[0]?.note).toBe('First line. Second line.');
  });

  it('treats a comment separated by a blank line as a heading', () => {
    // "# Payments" above a gap is about the section, not about whatever happens
    // to come next.
    const result = parseDotenv('# Payments\n\nTOKEN=abc');
    expect(result.vars[0]?.note).toBeUndefined();
  });

  it('does not carry a comment past the variable it described', () => {
    const result = parseDotenv('# About A.\nA=1\nB=2');
    expect(result.vars[0]?.note).toBe('About A.');
    expect(result.vars[1]?.note).toBeUndefined();
  });

  it('strips the hashes and the space people put after them', () => {
    expect(parseDotenv('###   Loud.\nA=1').vars[0]?.note).toBe('Loud.');
  });

  it('writes a note back out as a comment', () => {
    expect(formatDotenv([{ key: 'A', value: '1', note: 'Why.' }])).toBe('# Why.\nA=1\n');
  });

  it('survives a full round trip, which is the point', () => {
    // The exit criterion this was written for: comments and quoted values both
    // come back. Losing the comments means losing the only explanation of what
    // any of it is for.
    const original = '# The database.\nDB_URL="postgres://host/db"\n\n# Unrelated heading\nB=2\n';
    const first = parseDotenv(original);
    const second = parseDotenv(formatDotenv(first.vars));

    expect(second.vars).toEqual(first.vars);
    expect(second.vars[0]?.note).toBe('The database.');
    expect(second.vars[0]?.value).toBe('postgres://host/db');
  });

  it('flattens a multi-line note so the file stays readable', () => {
    // A newline inside a note would break the file into lines that are not
    // comments and would then fail to parse back.
    const written = formatDotenv([{ key: 'A', value: '1', note: 'One.\nTwo.' }]);
    expect(written).toBe('# One. Two.\nA=1\n');
    expect(parseDotenv(written).vars[0]?.note).toBe('One. Two.');
  });
});

describe('valueProblem', () => {
  it('names an empty value without calling it a mistake', () => {
    // Often deliberate: a flag meant to be blank. Worth naming, not worth
    // treating as an error.
    expect(valueProblem('')).toBe('empty');
    expect(valueProblem('   ')).toBe('empty');
  });

  it('catches the line that was never edited', () => {
    // The way a .env actually goes wrong: `.env.example` is copied, most of it
    // filled in, and two lines are not.
    expect(valueProblem('<your-token>')).toBe('placeholder');
    expect(valueProblem('changeme')).toBe('placeholder');
    expect(valueProblem('CHANGE_ME')).toBe('placeholder');
    expect(valueProblem('your-api-key-here')).toBe('placeholder');
    expect(valueProblem('TODO')).toBe('placeholder');
    expect(valueProblem('...')).toBe('placeholder');
  });

  it('stays quiet about values that only look like placeholders', () => {
    // A warning that fires on a real value is a warning nobody reads, and after
    // that the real one is missed too. `PROXY=none` and `LOG_LEVEL=off` are
    // things people set on purpose.
    expect(valueProblem('none')).toBeNull();
    expect(valueProblem('off')).toBeNull();
    expect(valueProblem('0')).toBeNull();
    expect(valueProblem('false')).toBeNull();
  });

  it('does not flag a generated secret', () => {
    // The check must never touch a real value. A generated password can look
    // like anything at all.
    for (const value of [
      'sk-proj-9Wz2mQx7Lr4TvB',
      'xoxb-123456789012-abcdefgh',
      'aG91c2Vob2xkLXNlY3JldA==',
      'postgres://user:pw@localhost:5432/db',
    ]) {
      expect(valueProblem(value), value).toBeNull();
    }
  });
});

describe('formatDockerArgs and formatComposeEnv', () => {
  const vars = [
    { key: 'PORT', value: '3000', note: null },
    { key: 'GREETING', value: 'hello world', note: null },
    { key: 'FLAG', value: 'no', note: null },
  ] as never;

  it('quotes a value with a space so it stays one argument', () => {
    // Unquoted, `--env GREETING=hello world` is two arguments and the second is
    // read as the image name.
    expect(formatDockerArgs(vars)).toContain('--env GREETING="hello world"');
    expect(formatDockerArgs(vars)).toContain('--env PORT=3000');
  });

  it('quotes every compose value, including the ones that look safe', () => {
    // YAML changes the meaning of unquoted scalars: `no` becomes false, `8.30`
    // becomes a number, `2026-08-29` becomes a date. A feature flag that reads
    // `no` and arrives as `false` is a bug nobody looks for in a quoting rule.
    const out = formatComposeEnv(vars);
    expect(out).toContain('FLAG: "no"');
    expect(out).toContain('PORT: "3000"');
  });

  it('indents where the block actually goes', () => {
    // Under `services:` and a service name. A fragment that has to be
    // re-indented by hand is most of the work this saves.
    const out = formatComposeEnv(vars);
    expect(out.split('\n')[0]).toBe('    environment:');
    expect(out.split('\n')[1]).toBe('      PORT: "3000"');
  });

  it('escapes a quote rather than ending the string early', () => {
    const out = formatComposeEnv([{ key: 'MSG', value: 'say "hi"', note: null }] as never);
    expect(out).toContain('MSG: "say \\"hi\\""');
  });
});
