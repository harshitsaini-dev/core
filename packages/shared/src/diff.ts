/**
 * A line diff.
 *
 * Written here for the same reason as the `.env` parser: what it compares are
 * production secrets, and it runs in the origin that holds the vault keys. A
 * diff library is a lot of surface to accept for an algorithm that is a
 * textbook exercise.
 *
 * Longest common subsequence, computed over lines. That is the right grain for
 * what this shows — a variable's value before and after a change. Most of those
 * are one line, where the answer is "the whole thing changed", and the ones
 * that are not are usually a private key or a connection string across several
 * lines, where a line is exactly the unit somebody wants to see.
 */

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
}

/**
 * The size beyond which this stops trying.
 *
 * The table is O(n × m), so two thousand-line values would allocate a million
 * cells to render something nobody would read. Past this the answer is simply
 * "all of it changed", which is both cheap and true enough.
 */
const MAX_LINES = 400;

export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) {
    return before === '' ? [] : split(before).map((text) => ({ kind: 'same', text }));
  }

  const a = split(before);
  const b = split(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }

  // lcs[i][j] is the length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i];
      const next = lcs[i + 1];
      if (!row || !next) continue;

      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
      continue;
    }

    // Removals before additions on a tie, so a changed line reads as the old
    // one struck out and the new one beneath it, in that order.
    const down = lcs[i + 1]?.[j] ?? 0;
    const right = lcs[i]?.[j + 1] ?? 0;

    if (down >= right) {
      out.push({ kind: 'removed', text: a[i] ?? '' });
      i += 1;
    } else {
      out.push({ kind: 'added', text: b[j] ?? '' });
      j += 1;
    }
  }

  while (i < a.length) {
    out.push({ kind: 'removed', text: a[i] ?? '' });
    i += 1;
  }

  while (j < b.length) {
    out.push({ kind: 'added', text: b[j] ?? '' });
    j += 1;
  }

  return out;
}

function split(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** How many lines the diff touches. Used to say "3 changes" without listing them. */
export function countChanges(lines: readonly DiffLine[]): number {
  return lines.filter((line) => line.kind !== 'same').length;
}
