import { describe, expect, it } from 'vitest';
import {
  collectTags,
  describePasswordAge,
  itemSubtitle,
  orderFolders,
  passwordAgeDays,
} from './vault';
import type { DecryptedFolder, DecryptedItem, VaultItemData } from './vault';

function folder(
  id: string,
  parentId: string | null = null,
  overrides: Partial<DecryptedFolder> = {},
): DecryptedFolder {
  return {
    id,
    parentId,
    name: id,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

function item(fields: Partial<VaultItemData['fields']>): DecryptedItem {
  return {
    id: crypto.randomUUID(),
    folderId: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    lastUsedAt: null,
    data: { type: 'login', fields: { title: 'x', ...fields } },
  };
}

describe('orderFolders', () => {
  it('walks a tree depth first', () => {
    const ordered = orderFolders([
      folder('work'),
      folder('clients', 'work'),
      folder('personal'),
      folder('acme', 'clients'),
    ]);

    // Siblings first by sortOrder, then by name: "personal" precedes "work",
    // and each subtree is exhausted before the next sibling starts.
    expect(ordered.map((entry) => entry.folder.id)).toEqual([
      'personal',
      'work',
      'clients',
      'acme',
    ]);
  });

  it('reports depth so a flat list can be indented', () => {
    const ordered = orderFolders([folder('work'), folder('clients', 'work')]);
    expect(ordered.map((entry) => entry.depth)).toEqual([0, 1]);
  });

  it('sorts siblings by sortOrder, then by name without regard to case', () => {
    const ordered = orderFolders([
      folder('b', null, { name: 'beta', sortOrder: 1 }),
      folder('a', null, { name: 'Alpha', sortOrder: 1 }),
      folder('z', null, { name: 'zeta', sortOrder: 0 }),
    ]);

    expect(ordered.map((entry) => entry.folder.name)).toEqual(['zeta', 'Alpha', 'beta']);
  });

  it('keeps an orphan rather than hiding it', () => {
    // The parent was deleted on another device and this one has not pulled the
    // delete yet. Dropping the child would read as data loss.
    const ordered = orderFolders([folder('child', 'missing-parent')]);
    expect(ordered.map((entry) => entry.folder.id)).toEqual(['child']);
  });

  it('survives a cycle instead of hanging the tab', () => {
    // The server cannot detect a cycle longer than one hop: it cannot read the
    // names and has no reason to walk the tree. So the client must not assume
    // the shape it is given is a tree.
    const ordered = orderFolders([folder('a', 'b'), folder('b', 'a')]);

    expect(ordered).toHaveLength(2);
    expect(ordered.map((entry) => entry.folder.id).sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for nothing', () => {
    expect(orderFolders([])).toEqual([]);
  });
});

describe('collectTags', () => {
  it('deduplicates across items and sorts', () => {
    const tags = collectTags([
      item({ tags: ['work', 'banking'] }),
      item({ tags: ['banking', 'archive'] }),
    ]);

    expect(tags).toEqual(['archive', 'banking', 'work']);
  });

  it('ignores blank and whitespace-only tags', () => {
    expect(collectTags([item({ tags: ['  ', '', ' work '] })])).toEqual(['work']);
  });

  it('sorts without regard to case', () => {
    expect(collectTags([item({ tags: ['zeta', 'Alpha'] })])).toEqual(['Alpha', 'zeta']);
  });

  it('returns nothing when nothing is tagged', () => {
    expect(collectTags([item({})])).toEqual([]);
  });
});

describe('itemSubtitle', () => {
  it('shows only the last four digits of a card', () => {
    // The first twelve are the part worth protecting; the last four are how
    // people tell one card from another.
    const subtitle = itemSubtitle({
      type: 'card',
      fields: { title: 'Bank', number: '4111111111111111' },
    });

    expect(subtitle).toBe('•••• 1111');
    expect(subtitle).not.toContain('4111');
  });

  it('never shows a password', () => {
    expect(
      itemSubtitle({ type: 'login', fields: { title: 'x', password: 'hunter2' } }),
    ).not.toContain('hunter2');
  });
});

describe('passwordAgeDays', () => {
  const NOW = 1_700_000_000_000;
  const day = 86_400_000;

  it('reports nothing for a password that was never stamped', () => {
    // Every item stored before this existed. "Unknown" is the truth; zero would
    // be a lie that reads as "changed today".
    expect(passwordAgeDays({ title: 'x' }, NOW)).toBeNull();
  });

  it('counts whole days', () => {
    expect(passwordAgeDays({ title: 'x', passwordChangedAt: NOW - day * 3 }, NOW)).toBe(3);
    expect(passwordAgeDays({ title: 'x', passwordChangedAt: NOW - day * 0.9 }, NOW)).toBe(0);
  });

  it('reports nothing for a stamp in the future', () => {
    // A clock that was wrong when the item was saved. "In -4 days" helps nobody.
    expect(passwordAgeDays({ title: 'x', passwordChangedAt: NOW + day }, NOW)).toBeNull();
  });
});

describe('describePasswordAge', () => {
  it('says nothing when the age is unknown', () => {
    expect(describePasswordAge(null)).toBeNull();
  });

  it('reads naturally at each scale', () => {
    expect(describePasswordAge(0)).toBe('set today');
    expect(describePasswordAge(1)).toBe('set yesterday');
    expect(describePasswordAge(5)).toBe('set 5 days ago');
    expect(describePasswordAge(60)).toBe('set 2 month(s) ago');
    expect(describePasswordAge(800)).toBe('set 2 year(s) ago');
  });

  it('never tells anybody their password has expired', () => {
    // Scheduled rotation is advice its own authors withdrew. This reports a
    // number; it does not nag.
    for (const days of [0, 10, 100, 1000, 10_000]) {
      const text = describePasswordAge(days) ?? '';
      expect(text.toLowerCase(), `${days} days`).not.toMatch(/expired|change it|too old|weak/);
    }
  });
});
