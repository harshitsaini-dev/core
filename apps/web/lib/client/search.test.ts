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

    expect(pinFavourites([plain, starred, another])).toEqual([plain, starred, another].sort(
      (x, y) => Number(y.favorite) - Number(x.favorite),
    ));
    expect(pinFavourites([plain, starred, another])[0]).toBe(starred);
  });
});
