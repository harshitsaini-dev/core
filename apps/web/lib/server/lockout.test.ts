import { describe, expect, it } from 'vitest';
import { LIMITS } from './rate-limit';
import { LOCKOUT_THRESHOLD, thresholdInWords, windowInWords } from './lockout';

/**
 * The lockout's numbers, and the two ways they went wrong.
 *
 * A threshold above the login bucket is one a single caller can never reach: a
 * rate-limited request is refused before it reaches the counter. It was ten
 * against a bucket of five, so the lockout — and the alert and the emailed link
 * built on it — fired for almost nobody.
 *
 * And the emails wrote the number out in prose, so lowering it left them
 * telling people that ten attempts had failed when five had. Worse than saying
 * nothing: somebody reading that would conclude a stranger made the other five.
 */

describe('the lockout threshold', () => {
  it('is reachable within what the limiter allows', () => {
    expect(LOCKOUT_THRESHOLD).toBeLessThanOrEqual(LIMITS.login.capacity);
  });

  it('is described with the number it actually is', () => {
    // The guard against the prose going stale again.
    const words = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ];
    expect(thresholdInWords()).toBe(words[LOCKOUT_THRESHOLD]);
  });

  it('describes a window somebody can wait out', () => {
    expect(windowInWords()).toBe('fifteen');
  });
});
