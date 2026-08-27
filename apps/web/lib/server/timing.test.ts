import { describe, expect, it } from 'vitest';
import { AUTH_RESPONSE_BUDGET_MS, constantTime } from './timing';

describe('constantTime', () => {
  it('returns the value the work produced', async () => {
    const { value } = await constantTime(async () => 'result', 20);
    expect(value).toBe('result');
  });

  it('does not return before the budget has elapsed', async () => {
    const started = performance.now();
    await constantTime(async () => 'fast', 100);
    expect(performance.now() - started).toBeGreaterThanOrEqual(95);
  });

  it('flattens work of wildly different durations to the same response time', async () => {
    // The property the whole design rests on: a fast path and a slow path must
    // be indistinguishable from outside.
    const time = async (workMs: number): Promise<number> => {
      const started = performance.now();
      await constantTime(() => new Promise((resolve) => setTimeout(resolve, workMs)), 150);
      return performance.now() - started;
    };

    const fast = await time(1);
    const slow = await time(60);

    expect(Math.abs(fast - slow)).toBeLessThan(20);
  });

  it('reports the real duration of the work, for monitoring', async () => {
    const { elapsedMs } = await constantTime(
      () => new Promise((resolve) => setTimeout(resolve, 40)),
      200,
    );
    expect(elapsedMs).toBeGreaterThanOrEqual(35);
    expect(elapsedMs).toBeLessThan(120);
  });

  it('flags a run that overran, because padding then hides nothing', async () => {
    const { overran } = await constantTime(
      () => new Promise((resolve) => setTimeout(resolve, 60)),
      10,
    );
    expect(overran).toBe(true);
  });

  it('does not flag a run that fitted inside the budget', async () => {
    const { overran } = await constantTime(async () => null, 50);
    expect(overran).toBe(false);
  });

  it('propagates errors rather than swallowing them', async () => {
    // Documented behaviour, not an oversight: a throwing handler returns early
    // and therefore leaks timing, so auth paths must not throw. Asserting it
    // here keeps that contract visible.
    await expect(
      constantTime(async () => {
        throw new Error('boom');
      }, 50),
    ).rejects.toThrow('boom');
  });

  it('uses a budget with room for a slow edge database round trip', () => {
    expect(AUTH_RESPONSE_BUDGET_MS).toBeGreaterThanOrEqual(100);
  });
});
