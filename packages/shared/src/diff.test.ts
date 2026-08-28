import { describe, expect, it } from 'vitest';
import { countChanges, diffLines } from './diff';

/**
 * The diff.
 *
 * Written here rather than pulled in, so it has to actually be right. The cases
 * that matter are the ones a secret produces: a single line replaced entirely,
 * a key that gained a line in the middle, and a value that did not change at
 * all — where showing a diff would be a lie.
 */

const kinds = (before: string, after: string) => diffLines(before, after).map((line) => line.kind);
const texts = (before: string, after: string) => diffLines(before, after).map((line) => line.text);

describe('diffLines', () => {
  it('reports nothing for identical text', () => {
    expect(kinds('same', 'same')).toEqual(['same']);
    expect(countChanges(diffLines('same', 'same'))).toBe(0);
  });

  it('returns nothing at all for two empty values', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('shows a one-line replacement as a removal then an addition', () => {
    // The order matters: struck out first, replacement beneath, which is how
    // every diff anybody has read is laid out.
    expect(kinds('old', 'new')).toEqual(['removed', 'added']);
    expect(texts('old', 'new')).toEqual(['old', 'new']);
  });

  it('keeps the lines that did not change', () => {
    const before = 'one\ntwo\nthree';
    const after = 'one\nCHANGED\nthree';

    expect(kinds(before, after)).toEqual(['same', 'removed', 'added', 'same']);
  });

  it('shows an inserted line as an addition alone', () => {
    expect(kinds('one\nthree', 'one\ntwo\nthree')).toEqual(['same', 'added', 'same']);
  });

  it('shows a deleted line as a removal alone', () => {
    expect(kinds('one\ntwo\nthree', 'one\nthree')).toEqual(['same', 'removed', 'same']);
  });

  it('handles a value that was empty before', () => {
    expect(kinds('', 'something')).toEqual(['removed', 'added']);
  });

  it('handles a value that became empty', () => {
    expect(kinds('something', '')).toEqual(['removed', 'added']);
  });

  it('treats a Windows line ending as the same line', () => {
    // Otherwise a value pasted from a Windows machine reads as every line
    // changed.
    expect(countChanges(diffLines('one\r\ntwo', 'one\ntwo'))).toBe(0);
  });

  it('finds the common part of a multi-line key', () => {
    const before = '-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----';
    const after = '-----BEGIN KEY-----\nAAAA\nCCCC\n-----END KEY-----';

    expect(countChanges(diffLines(before, after))).toBe(2);
    expect(kinds(before, after)).toEqual(['same', 'same', 'removed', 'added', 'same']);
  });

  it('keeps every line of both sides somewhere in the output', () => {
    // The property that makes a diff trustworthy: nothing is dropped. A diff
    // that quietly loses a line of a private key would be worse than no diff.
    const before = 'a\nb\nc\nd';
    const after = 'a\nx\nc\ny\nz';
    const lines = diffLines(before, after);

    const kept = lines.filter((line) => line.kind !== 'added').map((line) => line.text);
    const produced = lines.filter((line) => line.kind !== 'removed').map((line) => line.text);

    expect(kept).toEqual(before.split('\n'));
    expect(produced).toEqual(after.split('\n'));
  });

  it('gives up gracefully on something far too large to read', () => {
    // The table is O(n × m). Past the cap the answer is "all of it changed",
    // which is cheap and true enough for something nobody would read anyway.
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');

    const lines = diffLines(before, after);
    expect(lines.every((line) => line.kind !== 'same')).toBe(true);
    expect(lines).toHaveLength(1000);
  });
});

describe('countChanges', () => {
  it('counts only what moved', () => {
    expect(countChanges(diffLines('one\ntwo', 'one\nTWO'))).toBe(2);
  });
});
