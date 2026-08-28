import { describe, expect, it } from 'vitest';
import { mergeNewest } from './items-store';

/**
 * What a pull is allowed to overwrite.
 *
 * This is tested here rather than through the browser, and that is a
 * correction rather than a preference. Twice I wrote an end-to-end test that
 * claimed to reproduce the race — holding a response, blocking the push,
 * rewinding the cursor — and twice it passed with the fix removed, which means
 * it was never exercising this path at all. A test that cannot fail is worse
 * than no test: it reports a property nobody has actually checked.
 *
 * The rule is small enough to check exactly, so it is checked exactly.
 */

const T = 1_700_000_000_000;

interface Row {
  id: string;
  updatedAt: number;
  label: string;
}

const row = (id: string, updatedAt: number, label = id): Row => ({ id, updatedAt, label });

describe('mergeNewest', () => {
  it('takes everything when there is nothing local', () => {
    expect(mergeNewest([], [row('a', T)])).toEqual([row('a', T)]);
  });

  it('keeps what the server has not heard of', () => {
    // An item created a moment ago and not yet pushed. A pull that dropped it
    // would delete it from the screen while it sat in the outbox.
    const merged = mergeNewest([row('local', T)], [row('remote', T)]);
    expect(merged.map((entry) => entry.id).sort()).toEqual(['local', 'remote']);
  });

  it('takes the server copy when it is newer', () => {
    const merged = mergeNewest([row('a', T, 'stale')], [row('a', T + 1000, 'fresh')]);
    expect(merged[0]?.label).toBe('fresh');
  });

  it('keeps the local copy when it is newer', () => {
    // The whole point: the response left before this change was made.
    const merged = mergeNewest([row('a', T + 1000, 'edited')], [row('a', T, 'as sent')]);
    expect(merged[0]?.label).toBe('edited');
  });

  it('prefers the server copy on an exact tie', () => {
    // A tie means nothing changed locally — an unstamped local edit would land
    // here and lose, which is why every local change stamps `updatedAt`.
    const merged = mergeNewest([row('a', T, 'local')], [row('a', T, 'server')]);
    expect(merged[0]?.label).toBe('server');
  });

  it('would lose an unstamped delete, which is why they are stamped', () => {
    // Written as the failure it prevents. A delete that moved `deletedAt` and
    // left `updatedAt` alone arrives here as a tie and the server wins, so the
    // item reappears in the list.
    const deletedLocally: Row & { deletedAt: number | null } = { ...row('a', T), deletedAt: T + 5 };
    const stillOnServer: Row & { deletedAt: number | null } = { ...row('a', T), deletedAt: null };

    expect(mergeNewest([deletedLocally], [stillOnServer])[0]?.deletedAt).toBeNull();

    // Stamped, it survives.
    const stamped: Row & { deletedAt: number | null } = { ...row('a', T + 5), deletedAt: T + 5 };
    expect(mergeNewest([stamped], [stillOnServer])[0]?.deletedAt).toBe(T + 5);
  });

  it('does not duplicate an item that is on both sides', () => {
    expect(mergeNewest([row('a', T)], [row('a', T + 1)])).toHaveLength(1);
  });

  it('leaves the inputs alone', () => {
    const local = [row('a', T)];
    const incoming = [row('a', T + 1)];

    mergeNewest(local, incoming);

    expect(local[0]?.updatedAt).toBe(T);
    expect(incoming[0]?.updatedAt).toBe(T + 1);
  });

  it('handles an empty response', () => {
    expect(mergeNewest([row('a', T)], [])).toEqual([row('a', T)]);
  });
});
