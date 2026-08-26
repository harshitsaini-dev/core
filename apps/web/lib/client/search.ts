import { itemSubtitle } from '@core/shared';
import type { DecryptedItem } from '@core/shared';

/**
 * Fuzzy search over the decrypted vault.
 *
 * Client-side by necessity, not by preference: the server holds ciphertext and
 * could not search it if it wanted to. That constraint turns out to be an
 * advantage — the whole vault is already in memory, so matching is a loop over
 * a few hundred strings rather than a query.
 *
 * Written rather than imported. A fuzzy matcher is about eighty lines; the
 * usual library is twenty kilobytes on a page that a phone loads before it can
 * show anything, and this one only has to rank a list a person can scroll.
 */

export interface SearchResult {
  readonly item: DecryptedItem;
  readonly score: number;
}

/**
 * Score `query` against `text`.
 *
 * Returns 0 for no match. Higher is better. The weights encode what people
 * actually mean when they type three letters into a password manager: they are
 * looking for something they already know is there, so a prefix match on the
 * title is almost always the intended answer.
 */
export function score(query: string, text: string): number {
  if (query === '') return 1;
  if (text === '') return 0;

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  // Exact, then prefix, then substring. Cheap to check and covers most typing.
  if (haystack === needle) return 1000;
  if (haystack.startsWith(needle)) return 800 - haystack.length;

  const index = haystack.indexOf(needle);
  if (index !== -1) {
    // Earlier is better, and a match at a word boundary beats one mid-word:
    // "git" should find "GitHub" before "Digit".
    const boundary = index === 0 || /[\s._/-]/.test(haystack[index - 1] ?? '');
    return 500 - index + (boundary ? 100 : 0);
  }

  // Subsequence: the typo-tolerant part. "gogle" still finds "Google", and
  // "ghb" finds "GitHub", because people type initials.
  let position = 0;
  let matched = 0;
  let runs = 0;
  let previous = -2;

  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found === -1) return 0;

    matched += 1;
    // Consecutive characters are much stronger evidence than scattered ones.
    if (found !== previous + 1) runs += 1;
    previous = found;
    position = found + 1;
  }

  if (matched !== needle.length) return 0;

  // Fewer runs means the letters appeared together. A single run of the whole
  // query is effectively a substring match that indexOf missed on case.
  return Math.max(1, 200 - runs * 20 - haystack.length);
}

/**
 * Rank items against a query.
 *
 * Searches title, subtitle and tags. Deliberately not the password or notes:
 * matching on a password would mean a shoulder-surfer could confirm a guess by
 * watching the list filter, and matching on note bodies makes every long note
 * match everything.
 */
export function search(items: readonly DecryptedItem[], query: string): SearchResult[] {
  const trimmed = query.trim();

  if (trimmed === '') {
    return items.map((item) => ({ item, score: 1 }));
  }

  const results: SearchResult[] = [];

  for (const item of items) {
    const title = item.data.fields.title;
    const subtitle = itemSubtitle(item.data);
    const tags = item.data.fields.tags ?? [];

    const best = Math.max(
      score(trimmed, title),
      // Subtitle and tags are supporting evidence, never the headline.
      score(trimmed, subtitle) * 0.6,
      ...tags.map((tag) => score(trimmed, tag) * 0.8),
    );

    if (best > 0) {
      results.push({ item, score: best });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

export type SortOrder = 'recent' | 'title' | 'created' | 'used';

/** Order a list that is not being searched. */
export function sortItems(items: readonly DecryptedItem[], order: SortOrder): DecryptedItem[] {
  const sorted = [...items];

  switch (order) {
    case 'title':
      return sorted.sort((a, b) =>
        a.data.fields.title.localeCompare(b.data.fields.title, undefined, { sensitivity: 'base' }),
      );
    case 'created':
      return sorted.sort((a, b) => b.createdAt - a.createdAt);
    case 'used':
      return sorted.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    case 'recent':
    default:
      return sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Favourites first, then the given order. Applied after sorting or ranking. */
export function pinFavourites(items: readonly DecryptedItem[]): DecryptedItem[] {
  return [...items].sort((a, b) => Number(b.favorite) - Number(a.favorite));
}
