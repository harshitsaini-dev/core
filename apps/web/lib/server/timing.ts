/**
 * Constant-time responses.
 *
 * An authentication endpoint that answers faster for an unknown email than for
 * a known one is a user-enumeration oracle, no matter how carefully its error
 * messages are worded. Writing branch-free handler code is not enough either:
 * a database lookup that finds a row simply does more work than one that does
 * not, and no amount of care at the application level changes that.
 *
 * So instead of trying to make the work equal, we make the *response* equal:
 * every call is padded out to a fixed budget. Under the budget, the handler
 * waits. Over it, we log — because a handler that regularly overruns has
 * stopped being constant-time and the padding is no longer hiding anything.
 */

/**
 * The floor, in milliseconds.
 *
 * Chosen to sit comfortably above a slow D1 round trip at the edge, so that
 * genuine variance disappears underneath it. Raising it costs users latency;
 * lowering it risks the real work poking out the top.
 */
export const AUTH_RESPONSE_BUDGET_MS = 120;

/** Milliseconds since some fixed origin. Monotonic where available. */
function now(): number {
  return performance.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ConstantTimeResult<T> {
  readonly value: T;
  /** How long the real work took. Exposed for tests and monitoring. */
  readonly elapsedMs: number;
  /** True when the work exceeded the budget and padding could not hide it. */
  readonly overran: boolean;
}

/**
 * Run `work` and do not return before `budgetMs` has elapsed.
 *
 * Note what this does *not* do: it does not catch errors. A handler that throws
 * returns immediately and therefore leaks timing. Callers on authentication
 * paths must convert failures into ordinary return values before calling this —
 * which is also why the auth handlers below never use exceptions for control
 * flow.
 */
export async function constantTime<T>(
  work: () => Promise<T>,
  budgetMs: number = AUTH_RESPONSE_BUDGET_MS,
): Promise<ConstantTimeResult<T>> {
  const started = now();
  const value = await work();
  const elapsedMs = now() - started;

  const remaining = budgetMs - elapsedMs;
  if (remaining > 0) {
    await sleep(remaining);
  }

  return { value, elapsedMs, overran: remaining <= 0 };
}
