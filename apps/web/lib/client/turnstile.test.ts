import { describe, expect, it } from 'vitest';
import { widgetSize } from './turnstile';

/**
 * Which Turnstile widget fits.
 *
 * The default is a fixed 300px iframe, and a login panel on a phone is
 * narrower than that — 262px of content on a 360px screen — so the widget hung
 * out of the box it was in. This is the decision that stops it.
 */

describe('widgetSize', () => {
  it('fills the container where there is room', () => {
    expect(widgetSize(360)).toBe('flexible');
    expect(widgetSize(300)).toBe('flexible');
  });

  it('drops to the narrow one where there is not', () => {
    // 262px is what a 360px phone actually leaves, which is the case that
    // prompted this.
    expect(widgetSize(262)).toBe('compact');
    expect(widgetSize(180)).toBe('compact');
  });

  it('never asks for a size that cannot fit', () => {
    // The property, rather than three examples of it: whatever comes back must
    // be no wider than the space measured.
    const widths = { flexible: 300, compact: 150 } as const;

    for (let available = 140; available <= 500; available += 7) {
      expect(widths[widgetSize(available)]).toBeLessThanOrEqual(Math.max(available, 150));
    }
  });
});
