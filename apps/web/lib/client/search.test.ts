import type { DecryptedItem, VaultItemData } from '@core/shared';
import { describe, expect, it } from 'vitest';
import { pinFavourites, score, search, sortItems } from './search';

function item(
  title: string,
  overrides: Partial<DecryptedItem> = {},
  fields: Partial<VaultItemData['fields']> = {},
): DecryptedItem {
  return {
    id: title,
    folderId: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    lastUsedAt: null,
    data: { type: 'login', fields: { title, ...fields } },
    ...overrides,
  };
}

describe('score', () => {
  it('rates an exact match highest', () => {
    expect(score('github', 'GitHub')).toBeGreaterThan(score('github', 'GitHub Actions'));
  });

  it('rates a prefix above a mid-string match', () => {
    expect(score('git', 'GitHub')).toBeGreaterThan(score('git', 'Digit Bank'));
  });

  it('prefers a word boundary to the middle of a word', () => {
    // "lab" should find "My Lab" before "Collaborate".
    expect(score('lab', 'My Lab')).toBeGreaterThan(score('lab', 'Collaborate'));
  });

  it('tolerates a dropped letter, which is the common typo', () => {
    expect(score('gogle', 'Google')).toBeGreaterThan(0);
  });

  it('matches initials, because people type them', () => {
    expect(score('ghb', 'GitHub')).toBeGreaterThan(0);
  });

  it('is case insensitive', () => {
    expect(score('GITHUB', 'github')).toBe(score('github', 'GITHUB'));
  });

  it('returns zero when a letter is simply absent', () => {
    expect(score('xyz', 'GitHub')).toBe(0);
  });

  it('treats an empty query as matching everything', () => {
    expect(score('', 'anything')).toBeGreaterThan(0);
  });

  it('scores nothing against empty text', () => {
    expect(score('a', '')).toBe(0);
  });
});

describe('search', () => {
  const vault = [
    item('GitHub'),
    item('GitLab'),
    item('Google', {}, { username: 'me@gmail.com' }),
    item('Bank of Somewhere', {}, { tags: ['finance'] }),
    item('Digit Wallet'),
  ];

  it('returns everything for an empty query', () => {
    expect(search(vault, '')).toHaveLength(vault.length);
    expect(search(vault, '   ')).toHaveLength(vault.length);
  });

  it('ranks the obvious answer first', () => {
    expect(search(vault, 'github')[0]?.item.data.fields.title).toBe('GitHub');
    expect(search(vault, 'git')[0]?.item.data.fields.title).toMatch(/^Git/);
  });

  it('finds an item by a tag', () => {
    const results = search(vault, 'finance');
    expect(results[0]?.item.data.fields.title).toBe('Bank of Somewhere');
  });

  it('finds an item by its username', () => {
    const results = search(vault, 'gmail');
    expect(results[0]?.item.data.fields.title).toBe('Google');
  });

  it('ranks a title match above a subtitle match', () => {
    // Otherwise typing a common email domain buries the item you meant.
    const items = [item('Something Else', {}, { username: 'bank@example.com' }), item('Bank')];
    expect(search(items, 'bank')[0]?.item.data.fields.title).toBe('Bank');
  });

  it('excludes items that do not match at all', () => {
    expect(search(vault, 'zzzzz')).toHaveLength(0);
  });

  it('never matches on the password', async () => {
    // A list that filtered as a password was typed would let somebody confirm a
    // guess by watching the screen.
    const items = [item('Unrelated', {}, { password: 'correct-horse-battery' })];
    expect(search(items, 'correct-horse-battery')).toHaveLength(0);
  });
});

describe('sortItems', () => {
  const a = item('Alpha', { createdAt: 300, updatedAt: 100, lastUsedAt: 5 });
  const b = item('zeta', { createdAt: 100, updatedAt: 300, lastUsedAt: 50 });
  const c = item('Mu', { createdAt: 200, updatedAt: 200, lastUsedAt: null });

  it('sorts by title without regard to case', () => {
    // A case-sensitive sort puts "zeta" before "Alpha", which reads as broken.
    expect(sortItems([b, a, c], 'title').map((entry) => entry.data.fields.title)).toEqual([
      'Alpha',
      'Mu',
      'zeta',
    ]);
  });

  it('sorts by most recently changed', () => {
    expect(sortItems([a, b, c], 'recent')[0]).toBe(b);
  });

  it('sorts by newest first', () => {
    expect(sortItems([a, b, c], 'created')[0]).toBe(a);
  });

  it('sorts by most recently used, with never-used last', () => {
    const ordered = sortItems([a, b, c], 'used');
    expect(ordered[0]).toBe(b);
    expect(ordered.at(-1)).toBe(c);
  });

  it('does not mutate the input', () => {
    const input = [b, a, c];
    sortItems(input, 'title');
    expect(input).toEqual([b, a, c]);
  });
});

describe('pinFavourites', () => {
  it('lifts favourites to the top without disturbing the rest', () => {
    const plain = item('Plain');
    const starred = item('Starred', { favorite: true });
    const another = item('Another');

    expect(pinFavourites([plain, starred, another])).toEqual(
      [plain, starred, another].sort((x, y) => Number(y.favorite) - Number(x.favorite)),
    );
    expect(pinFavourites([plain, starred, another])[0]).toBe(starred);
  });
});

describe('performance', () => {
  /**
   * The Phase 3 exit criterion: search across a thousand items in under 50ms.
   *
   * It matters because searching is the only way to find anything, and it runs
   * on every keystroke over the whole decrypted vault — there is no index and
   * no server to ask. If this ever regresses, typing gets laggy on a phone
   * before it gets slow on a desktop, which is the wrong order to find out.
   */
  const vault = Array.from({ length: 1000 }, (_, index) =>
    item(
      `Account ${index} at service-${index % 97}.example.com`,
      {
        id: `item-${index}`,
        favorite: index % 50 === 0,
      },
      {
        username: `user${index}@example.com`,
        tags: [`group-${index % 13}`],
      },
    ),
  );

  function timed(work: () => unknown): number {
    const started = performance.now();
    work();
    return performance.now() - started;
  }

  it('ranks a thousand items in under 50ms', () => {
    // Warm once so the measurement is not dominated by first-call costs.
    search(vault, 'service');

    const worst = Math.max(
      timed(() => search(vault, 'service')),
      // A query matching almost nothing still walks every item.
      timed(() => search(vault, 'zzzz')),
      // Subsequence matching is the expensive path.
      timed(() => search(vault, 'srvc')),
      timed(() => search(vault, 'a')),
    );

    expect(worst).toBeLessThan(50);
  });

  it('sorts and pins a thousand items in under 50ms', () => {
    // The no-query path, which is what the list shows by default.
    const elapsed = timed(() => pinFavourites(sortItems(vault, 'recent')));
    expect(elapsed).toBeLessThan(50);
  });

  it('stays fast as a query grows', () => {
    // A long query means more subsequence work per item; the cost should not
    // run away.
    const elapsed = timed(() => search(vault, 'account at service example com'));
    expect(elapsed).toBeLessThan(50);
  });
});
