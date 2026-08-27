import { z } from 'zod';

/**
 * What a vault item actually contains.
 *
 * This whole shape is encrypted into a single blob before it leaves the
 * browser, which is why it can afford to be generous: a column per field would
 * leak which optional fields a user filled in, and adding a field later would
 * mean a migration. Here it costs nothing.
 *
 * The schemas are shared rather than duplicated client-side, because the client
 * is the only thing that ever validates them — the server sees ciphertext and
 * could not check this if it wanted to.
 */

/** An extra field a user added themselves. */
export const customFieldSchema = z.object({
  label: z.string().max(200),
  value: z.string().max(10_000),
  /** Rendered masked, like a password. Security answers, PINs, licence keys. */
  hidden: z.boolean().default(false),
});

export type CustomField = z.infer<typeof customFieldSchema>;

const baseFields = {
  title: z.string().min(1).max(200),
  notes: z.string().max(50_000).optional(),
  tags: z.array(z.string().max(60)).max(50).optional(),
  customFields: z.array(customFieldSchema).max(100).optional(),
};

export const loginFieldsSchema = z.object({
  ...baseFields,
  username: z.string().max(500).optional(),
  password: z.string().max(2000).optional(),
  url: z.string().max(2000).optional(),
  /** Base32, as printed by every authenticator setup screen. */
  totpSecret: z.string().max(512).optional(),
  /** Stored apart from the password: they are what survives losing it. */
  recoveryCodes: z.array(z.string().max(200)).max(50).optional(),
});

export const noteFieldsSchema = z.object({
  ...baseFields,
  /** Markdown. Long server configs and API notes live here. */
  body: z.string().max(200_000).optional(),
});

export const cardFieldsSchema = z.object({
  ...baseFields,
  cardholder: z.string().max(200).optional(),
  number: z.string().max(64).optional(),
  expiry: z.string().max(16).optional(),
  cvv: z.string().max(8).optional(),
  pin: z.string().max(16).optional(),
});

export const identityFieldsSchema = z.object({
  ...baseFields,
  fullName: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(64).optional(),
  address: z.string().max(1000).optional(),
});

export const sshFieldsSchema = z.object({
  ...baseFields,
  publicKey: z.string().max(20_000).optional(),
  privateKey: z.string().max(100_000).optional(),
  passphrase: z.string().max(2000).optional(),
  host: z.string().max(500).optional(),
});

export const vaultItemDataSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('login'), fields: loginFieldsSchema }),
  z.object({ type: z.literal('note'), fields: noteFieldsSchema }),
  z.object({ type: z.literal('card'), fields: cardFieldsSchema }),
  z.object({ type: z.literal('identity'), fields: identityFieldsSchema }),
  z.object({ type: z.literal('ssh'), fields: sshFieldsSchema }),
]);

export type VaultItemData = z.infer<typeof vaultItemDataSchema>;
export type LoginFields = z.infer<typeof loginFieldsSchema>;

/**
 * An item as the client holds it: decrypted contents plus the routing metadata
 * the server is allowed to see.
 */
export interface DecryptedItem {
  readonly id: string;
  readonly folderId: string | null;
  readonly favorite: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly data: VaultItemData;
}

/**
 * An item on the wire. `dataEnc` is opaque to everything between the two
 * browsers that can read it.
 */
export interface SyncedItem {
  readonly id: string;
  readonly type: VaultItemData['type'];
  readonly dataEnc: string;
  readonly folderId: string | null;
  readonly urlBlindIndex: string | null;
  readonly favorite: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
  readonly lastUsedAt: number | null;
}

/** How long a soft-deleted item stays recoverable. */
export const TRASH_RETENTION_DAYS = 30;

/** A blank item of each type, for the create form. */
export function emptyItem(type: VaultItemData['type']): VaultItemData {
  const fields = { title: '' };
  switch (type) {
    case 'login':
      return { type, fields };
    case 'note':
      return { type, fields };
    case 'card':
      return { type, fields };
    case 'identity':
      return { type, fields };
    case 'ssh':
      return { type, fields };
  }
}

/**
 * The single line shown under a title in the list.
 *
 * Never the password, obviously — but also never anything that reveals more
 * than the title already does. A card shows its last four digits because that
 * is how people tell cards apart, and because the first twelve are the part
 * worth protecting.
 */
export function itemSubtitle(data: VaultItemData): string {
  switch (data.type) {
    case 'login':
      return data.fields.username ?? data.fields.url ?? '';
    case 'note':
      return data.fields.body ? `${data.fields.body.slice(0, 60)}…` : '';
    case 'card':
      return data.fields.number ? `•••• ${data.fields.number.slice(-4)}` : '';
    case 'identity':
      return data.fields.email ?? data.fields.fullName ?? '';
    case 'ssh':
      return data.fields.host ?? '';
  }
}

/**
 * A folder, as the client holds it.
 *
 * The name is encrypted like everything else; the colour is not, because a
 * swatch reveals nothing and the list needs it to render before anything is
 * decrypted.
 */
export interface DecryptedFolder {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly color: string | null;
  readonly sortOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

/** A folder on the wire. */
export interface SyncedFolder {
  readonly id: string;
  readonly parentId: string | null;
  readonly nameEnc: string;
  readonly color: string | null;
  readonly sortOrder: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

/**
 * Folder colours.
 *
 * A fixed set rather than a free colour picker. The palette is a single hue by
 * design, and letting people choose arbitrary colours would either break that
 * or produce swatches indistinguishable from each other on a black background.
 */
export const FOLDER_COLORS = ['#00FF41', '#00A82B', '#FFB020', '#FF3B30', '#7A7A7A'] as const;

/**
 * Order folders as a tree, depth-first.
 *
 * Returns a flat list with a depth on each, which is what a list renders. A
 * cycle — which the server cannot prevent, since it cannot read the names or
 * check the shape — is broken by refusing to visit a folder twice, so a
 * corrupted parent chain shows a flat list rather than hanging the tab.
 */
export function orderFolders(
  folders: readonly DecryptedFolder[],
): { folder: DecryptedFolder; depth: number }[] {
  const byParent = new Map<string | null, DecryptedFolder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentId, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  const ordered: { folder: DecryptedFolder; depth: number }[] = [];
  const visited = new Set<string>();

  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      ordered.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };

  walk(null, 0);

  // Anything unreachable from the root — an orphan whose parent was deleted, or
  // a member of a cycle — is appended rather than dropped. Hiding a folder
  // because its parent is missing would look like data loss.
  for (const folder of folders) {
    if (!visited.has(folder.id)) ordered.push({ folder, depth: 0 });
  }

  return ordered;
}

/** Every tag in use, sorted, deduplicated. */
export function collectTags(items: readonly DecryptedItem[]): string[] {
  const tags = new Set<string>();
  for (const item of items) {
    for (const tag of item.data.fields.tags ?? []) {
      const trimmed = tag.trim();
      if (trimmed !== '') tags.add(trimmed);
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
