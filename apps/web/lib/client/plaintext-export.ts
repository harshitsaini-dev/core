'use client';

import { itemSubtitle } from '@core/shared';
import type { DecryptedItem } from '@core/shared';

/**
 * Exporting a vault in the clear.
 *
 * This is the most dangerous thing the product can do, and the code says so
 * because the file will outlive anybody's memory of having made it. It ends up
 * in Downloads, then in a backup, then in a cloud sync, and every password in
 * it is readable by anything that reads a text file.
 *
 * It exists anyway, for one honest reason: a vault you cannot get out of is a
 * vault you are locked into, and a password manager that holds your data
 * hostage is a worse thing than one that lets you leave badly. Moving to
 * another manager means a CSV, because that is what every other manager reads.
 *
 * What that buys is the right to make the gate as heavy as it needs to be, and
 * to say plainly what the file is — which is the panel's job, not this file's.
 */

/** RFC 4180: quote anything with a comma, a quote or a newline; double the quotes. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const COLUMNS = ['type', 'title', 'username', 'password', 'url', 'notes', 'totp', 'tags'] as const;

/** What a login row carries. Other types fill what applies and leave the rest. */
function cells(item: DecryptedItem): string[] {
  const fields = item.data.fields as Record<string, unknown>;
  const value = (key: string): string => {
    const found = fields[key];
    return typeof found === 'string' ? found : '';
  };

  return [
    item.data.type,
    value('title'),
    value('username'),
    value('password'),
    value('url'),
    // The subtitle for a type with no notes field is better than an empty
    // column: a card exported with nothing but its title is not an export.
    value('notes') || itemSubtitle(item.data),
    value('totp'),
    (fields['tags'] as string[] | undefined)?.join(' ') ?? '',
  ];
}

/** Every live item, as CSV. Deleted items are not included; they were deleted. */
export function toCsv(items: readonly DecryptedItem[]): string {
  const rows = items
    .filter((item) => item.deletedAt === null)
    .map((item) => cells(item).map(csvCell).join(','));

  return [COLUMNS.join(','), ...rows].join('\n');
}

/**
 * Every live item, as JSON.
 *
 * Kept alongside CSV because a CSV flattens what a `.env` project or a note
 * with line breaks actually is, and somebody moving to a tool that reads JSON
 * should not have to accept that loss.
 */
export function toJson(items: readonly DecryptedItem[]): string {
  return JSON.stringify(
    {
      format: 'core.plaintext.v1',
      warning: 'This file is not encrypted. Every password in it is readable.',
      items: items
        .filter((item) => item.deletedAt === null)
        .map((item) => ({
          type: item.data.type,
          favorite: item.favorite,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          fields: item.data.fields,
        })),
    },
    null,
    2,
  );
}

/** The phrase somebody has to type. Deliberately not "yes" or "ok". */
export const CONFIRM_PHRASE = 'export in the clear';

export function exportFilename(kind: 'csv' | 'json'): string {
  const stamp = new Date().toISOString().slice(0, 10);
  // Named for what it is, so it is recognisable months later in a Downloads
  // folder full of files nobody remembers making.
  return `core-PLAINTEXT-${stamp}.${kind}`;
}
