import { describe, expect, it } from 'vitest';
import { bytesToHex } from './encoding.js';
import { randomBytes, randomChoice, randomInt, shuffleInPlace } from './random.js';

describe('randomBytes', () => {
  it('returns the requested length, including across the 64 KiB request limit', () => {
    for (const length of [0, 1, 32, 65_535, 65_536, 65_537, 200_000]) {
      expect(randomBytes(length)).toHaveLength(length);
    }
  });

  it('does not leave the tail of a large buffer unfilled', () => {
    // A naive implementation fills only the first chunk and silently returns
    // zeros after it - which would be catastrophic for key material.
    const bytes = randomBytes(200_000);
    const tail = bytes.subarray(150_000);
    expect(tail.some((byte) => byte !== 0)).toBe(true);
  });

  it('produces distinct values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(bytesToHex(randomBytes(16)));
    expect(seen.size).toBe(500);
  });

  it('rejects invalid lengths', () => {
    expect(() => randomBytes(-1)).toThrow(RangeError);
    expect(() => randomBytes(1.5)).toThrow(RangeError);
  });
});

describe('randomInt', () => {
  it('stays within range', () => {
    for (let i = 0; i < 5000; i += 1) {
      const value = randomInt(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });

  it('returns 0 for a range of one', () => {
    expect(randomInt(1)).toBe(0);
  });

  it('is roughly uniform, including for ranges that do not divide 2^32', () => {
    // 7 is the interesting case: `random % 7` would visibly favour low values.
    const counts = new Array<number>(7).fill(0);
    const samples = 70_000;
    for (let i = 0; i < samples; i += 1) {
      const bucket = randomInt(7);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }

    const expected = samples / 7;
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.06);
    }
  });

  it('covers the whole range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) seen.add(randomInt(20));
    expect(seen.size).toBe(20);
  });

  it('rejects invalid bounds', () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-5)).toThrow(RangeError);
    expect(() => randomInt(2.5)).toThrow(RangeError);
    expect(() => randomInt(2 ** 33)).toThrow(RangeError);
  });
});

describe('randomChoice', () => {
  it('only ever returns members of the array', () => {
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 300; i += 1) expect(items).toContain(randomChoice(items));
  });

  it('eventually returns every member', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) seen.add(randomChoice(['a', 'b', 'c']));
    expect(seen.size).toBe(3);
  });

  it('rejects an empty array', () => {
    expect(() => randomChoice([])).toThrow(RangeError);
  });
});

describe('shuffleInPlace', () => {
  it('preserves the multiset of elements', () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = shuffleInPlace([...original]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(original);
  });

  it('actually reorders', () => {
    const arrangements = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      arrangements.add(shuffleInPlace([1, 2, 3, 4, 5]).join(''));
    }
    expect(arrangements.size).toBeGreaterThan(50);
  });

  it('handles empty and single-element arrays', () => {
    expect(shuffleInPlace([])).toEqual([]);
    expect(shuffleInPlace(['only'])).toEqual(['only']);
  });
});
