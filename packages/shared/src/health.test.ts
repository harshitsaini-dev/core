import { describe, expect, it } from 'vitest';
import {
  duplicateItems,
  oldPasswords,
  reusedPasswords,
  withPassword,
  withoutPassword,
} from './health';
import type { DecryptedItem, LoginFields } from './vault';

/**
 * The vault health checks.
 *
 * These run in the browser because the server holds ciphertext and could not
 * tell a weak password from a strong one, or two identical ones from two
 * different ones. That is the product working as intended rather than a
 * limitation to work around.
 */

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function login(title: string, fields: Partial<LoginFields> = {}, deletedAt: number | null = null) {
  return {
    id: title,
    folderId: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    deletedAt,
    lastUsedAt: null,
    data: { type: 'login', fields: { title, ...fields } },
  } as DecryptedItem;
}

describe('reusedPasswords', () => {
  it('groups the items that share one password', () => {
    // "These three share a password" is a sentence somebody can act on. Listing
    // the pairs says the same fact three times.
    const groups = reusedPasswords([
      login('A', { password: 'same' }),
      login('B', { password: 'same' }),
      login('C', { password: 'same' }),
      login('D', { password: 'different' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.title)).toEqual(['A', 'B', 'C']);
  });

  it('never reports the password itself', () => {
    // Caught the first version of this, which returned whole items: a
    // `DecryptedItem` carries its password, so the report was a list of the
    // passwords worth stealing first with the reuse count beside each one.
    const groups = reusedPasswords([
      login('A', { password: 'hunter2' }),
      login('B', { password: 'hunter2' }),
    ]);

    expect(JSON.stringify(groups)).not.toContain('hunter2');
  });

  it('says nothing when nothing is shared', () => {
    expect(
      reusedPasswords([login('A', { password: 'one' }), login('B', { password: 'two' })]),
    ).toEqual([]);
  });

  it('ignores items in the trash', () => {
    // Something already deleted is not a problem to fix.
    const groups = reusedPasswords([
      login('A', { password: 'same' }),
      login('B', { password: 'same' }, 1),
    ]);

    expect(groups).toEqual([]);
  });

  it('ignores items with no password', () => {
    expect(reusedPasswords([login('A'), login('B')])).toEqual([]);
  });

  it('puts the widest problem first', () => {
    const groups = reusedPasswords([
      login('A', { password: 'twice' }),
      login('B', { password: 'twice' }),
      login('C', { password: 'thrice' }),
      login('D', { password: 'thrice' }),
      login('E', { password: 'thrice' }),
    ]);

    expect(groups[0]?.items).toHaveLength(3);
  });
});

describe('oldPasswords', () => {
  it('finds one that has not changed in over a year', () => {
    const items = [
      login('Ancient', { password: 'x', passwordChangedAt: NOW - DAY * 400 }),
      login('Recent', { password: 'x', passwordChangedAt: NOW - DAY * 10 }),
    ];

    expect(oldPasswords(items, NOW).map((item) => item.title)).toEqual(['Ancient']);
  });

  it('says nothing about a password whose age is unknown', () => {
    // Every item stored before the stamp existed. Guessing would turn "we do
    // not know" into "this is fine" or "this is bad", and both would be made up.
    expect(oldPasswords([login('Unstamped', { password: 'x' })], NOW)).toEqual([]);
  });

  it('puts the oldest first', () => {
    const items = [
      login('Older', { password: 'x', passwordChangedAt: NOW - DAY * 400 }),
      login('Oldest', { password: 'x', passwordChangedAt: NOW - DAY * 4000 }),
    ];

    expect(oldPasswords(items, NOW)[0]?.title).toBe('Oldest');
  });

  it('ignores the trash', () => {
    const item = login('Gone', { password: 'x', passwordChangedAt: NOW - DAY * 400 }, 1);
    expect(oldPasswords([item], NOW)).toEqual([]);
  });
});

describe('withoutPassword', () => {
  it('counts logins stored without one', () => {
    // Not a problem in itself, but an import that mapped the wrong column
    // produces exactly this in bulk, and this is how somebody finds out.
    const items = [login('No password'), login('Has one', { password: 'x' })];
    expect(withoutPassword(items).map((item) => item.title)).toEqual(['No password']);
  });
});

describe('withPassword', () => {
  it('is what the strength check runs over', () => {
    const items = [login('A', { password: 'x' }), login('B'), login('C', { password: 'y' }, 1)];
    expect(withPassword(items).map((item) => item.data.fields.title)).toEqual(['A']);
  });
});

describe('duplicateItems', () => {
  /** Same shape as `login`, but with an id of its own — two copies are two items. */
  function copy(id: string, title: string, fields: Partial<LoginFields> = {}) {
    return { ...login(title, fields), id } as DecryptedItem;
  }

  it('groups an account that was stored twice', () => {
    // The state a vault ends up in after importing from somewhere and then
    // importing again, which is now an easy thing to do by accident.
    const groups = duplicateItems([
      copy('1', 'GitHub', { username: 'kaya' }),
      copy('2', 'GitHub', { username: 'kaya' }),
      copy('3', 'Fastmail', { username: 'kaya' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['1', '2']);
  });

  it('does not call two accounts on one site duplicates', () => {
    // A work login and a personal login on the same site are two accounts, and
    // reporting them as a mistake would train somebody to ignore this list.
    expect(
      duplicateItems([
        copy('1', 'GitHub', { username: 'kaya' }),
        copy('2', 'GitHub', { username: 'kaya-work' }),
      ]),
    ).toEqual([]);
  });

  it('matches through a url the two exporters wrote differently', () => {
    // The whole point. One tool writes `https://github.com/login`, another
    // writes `github.com`, and keying on the URL would find nothing in exactly
    // the case this check exists for.
    const groups = duplicateItems([
      copy('1', 'GitHub', { username: 'kaya', url: 'https://github.com/login' }),
      copy('2', 'GitHub', { username: 'kaya', url: 'github.com' }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it('still groups copies whose passwords have drifted apart', () => {
    // These are the pair somebody most needs to see: one of the two is stale
    // and will not work, and which one is not knowable from here.
    const groups = duplicateItems([
      copy('1', 'GitHub', { username: 'kaya', password: 'old' }),
      copy('2', 'GitHub', { username: 'kaya', password: 'new' }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it('never reports a password', () => {
    const groups = duplicateItems([
      copy('1', 'GitHub', { username: 'kaya', password: 'hunter2' }),
      copy('2', 'GitHub', { username: 'kaya', password: 'hunter2' }),
    ]);

    expect(JSON.stringify(groups)).not.toContain('hunter2');
  });

  it('ignores what is in the trash', () => {
    // Deleting one of two copies is how somebody fixes this, and a finding that
    // survived the fix would be a list that can never be cleared.
    const deleted = { ...copy('2', 'GitHub', { username: 'kaya' }), deletedAt: 1 } as DecryptedItem;

    expect(duplicateItems([copy('1', 'GitHub', { username: 'kaya' }), deleted])).toEqual([]);
  });

  it('ignores case and surrounding space', () => {
    const groups = duplicateItems([
      copy('1', 'GitHub', { username: 'Kaya' }),
      copy('2', ' github ', { username: 'kaya ' }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it('does not treat two untitled items as the same thing', () => {
    // An item with no title says nothing about what it is, and grouping them
    // would put unrelated things in one finding.
    expect(duplicateItems([copy('1', ''), copy('2', '')])).toEqual([]);
  });
});
