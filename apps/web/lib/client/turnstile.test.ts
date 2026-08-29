import { describe, expect, it } from 'vitest';
import { waitForToken, widgetSize } from './turnstile';

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

describe('waitForToken', () => {
  /*
   * The widget is hidden until it has something to ask, so nothing on screen
   * says a check is running. Somebody pressing the button a second after the
   * page loads used to submit without a token and be told to complete a check
   * they could not see.
   */

  it('returns a token that arrives late', async () => {
    let token: string | null = null;
    setTimeout(() => (token = 'arrived'), 150);

    expect(await waitForToken(() => token, 2000)).toBe('arrived');
  });

  it('returns one that is already there without waiting', async () => {
    const started = Date.now();
    expect(await waitForToken(() => 'ready', 2000)).toBe('ready');
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('gives up rather than waiting forever', async () => {
    // A blocked script means no token is ever coming, and the server fails
    // open for exactly that. Waiting past the timeout would turn a check
    // designed to get out of the way into the thing in the way.
    expect(await waitForToken(() => null, 300)).toBeNull();
  });
});
