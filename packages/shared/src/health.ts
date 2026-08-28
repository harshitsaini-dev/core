import { passwordAgeDays } from './vault';
import type { DecryptedItem, LoginFields } from './vault';

/**
 * What is wrong with a vault.
 *
 * Every check here runs in the browser over decrypted items, because the server
 * cannot do any of it — it holds ciphertext and could not tell a weak password
 * from a strong one, or two identical ones from two different ones. That is not
 * a limitation to work around; it is the product working as intended, and it is
 * why this file exists on this side of the wall.
 *
 * The checks are the ones that are actually true. Reuse is a fact: the same
 * string in two places is one breach away from being two. Age is a number, and
 * is reported rather than judged — see ADR-024. Strength is the one honest
 * measure of a password's own quality, and it needs a dictionary, so it is
 * combined with these in the app rather than here.
 */

/** A login item and the fields it actually has. */
function loginFields(item: DecryptedItem): LoginFields | null {
  return item.data.type === 'login' ? item.data.fields : null;
}

/**
 * An item, as a report is allowed to describe it.
 *
 * An id and a title, not the item. The first version of this returned whole
 * items and a test caught what that meant: a `DecryptedItem` carries its
 * password, so a "reused passwords" report was a list of the passwords worth
 * stealing first, with the reuse count next to each one.
 */
export interface HealthEntry {
  readonly id: string;
  readonly title: string;
}

function entry(item: DecryptedItem): HealthEntry {
  return { id: item.id, title: item.data.fields.title };
}

export interface ReusedGroup {
  /** The items sharing one password. Never the password itself. */
  readonly items: readonly HealthEntry[];
}

/**
 * Passwords used in more than one place.
 *
 * Grouped rather than listed as pairs, because "these four accounts share a
 * password" is the sentence somebody can act on, and "A matches B, B matches C,
 * A matches C" is the same fact said three times.
 *
 * The password is used as a grouping key and never leaves this function. A
 * report that named the reused value would be a list of the passwords worth
 * stealing first.
 */
export function reusedPasswords(items: readonly DecryptedItem[]): ReusedGroup[] {
  const byPassword = new Map<string, DecryptedItem[]>();

  for (const item of items) {
    if (item.deletedAt !== null) continue;

    const password = loginFields(item)?.password;
    if (!password) continue;

    const group = byPassword.get(password) ?? [];
    group.push(item);
    byPassword.set(password, group);
  }

  return [...byPassword.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ items: group.map(entry) }))
    .sort((a, b) => b.items.length - a.items.length);
}

/**
 * Items whose password has not changed in a long time.
 *
 * A year is the threshold, and the wording matters: these are *old*, not
 * *expired*. Scheduled rotation is advice its own authors withdrew, and this
 * list exists to surface the password somebody set in 2011 and forgot, not to
 * nag about one set last spring.
 */
export const OLD_PASSWORD_DAYS = 365;

export function oldPasswords(items: readonly DecryptedItem[], now = Date.now()): HealthEntry[] {
  return items
    .filter((item) => {
      if (item.deletedAt !== null) return false;

      const fields = loginFields(item);
      if (!fields?.password) return false;

      const days = passwordAgeDays(fields, now);
      return days !== null && days >= OLD_PASSWORD_DAYS;
    })
    .sort((a, b) => {
      const left = loginFields(a) ? passwordAgeDays(loginFields(a) as LoginFields, now) : 0;
      const right = loginFields(b) ? passwordAgeDays(loginFields(b) as LoginFields, now) : 0;
      return (right ?? 0) - (left ?? 0);
    })
    .map(entry);
}

/**
 * Items with no password at all.
 *
 * Not a problem in itself — plenty of logins are stored for the username alone
 * — so this is counted and not warned about. It is here because an import that
 * mapped the wrong column produces exactly this, in bulk, and seeing "94 items
 * with no password" the day after an import is how somebody finds out.
 */
export function withoutPassword(items: readonly DecryptedItem[]): HealthEntry[] {
  return items
    .filter(
      (item) =>
        item.deletedAt === null && item.data.type === 'login' && !loginFields(item)?.password,
    )
    .map(entry);
}

/** Every login that has a password, which is what the strength check runs over. */
export function withPassword(items: readonly DecryptedItem[]): DecryptedItem[] {
  return items.filter((item) => item.deletedAt === null && Boolean(loginFields(item)?.password));
}
