/**
 * CSV, and what other password managers put in it.
 *
 * Written here rather than pulled in, for the third time and the same reason:
 * the file being parsed is somebody's entire password vault, exported in the
 * clear, and it is parsed in the origin that holds the keys to the new one. A
 * dependency at that point is a supply-chain path to every password the person
 * has ever had.
 *
 * RFC 4180 as everyone actually writes it: quoted fields, commas and newlines
 * inside quotes, doubled quotes as an escape, and a header row.
 */

export type CsvRow = readonly string[];

/**
 * Split a CSV into rows.
 *
 * Character by character rather than by line, because a Bitwarden export puts
 * multi-line notes inside quoted fields and splitting on newlines first turns
 * one item into six broken ones.
 */
export function parseCsv(input: string): CsvRow[] {
  const text = input.replace(/\r\n?/g, '\n');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };

  const endRow = (): void => {
    endField();
    // A trailing newline should not produce a row of one empty string.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      endField();
      index += 1;
      continue;
    }

    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/** The fields Core can fill from a row. */
export type ImportField = 'title' | 'username' | 'password' | 'url' | 'notes' | 'totp';

export type ColumnMapping = Partial<Record<ImportField, number>>;

/**
 * Header names the common exporters use.
 *
 * Matched case-insensitively and after stripping non-letters, so `login_uri`,
 * `Login URI` and `loginuri` are the same thing. Ordered by how specific they
 * are: `name` before `title` matters less than `loginpassword` before
 * `password`, which is Bitwarden's.
 */
const HEADERS: Record<ImportField, string[]> = {
  title: ['name', 'title', 'account', 'itemname', 'displayname'],
  username: ['loginusername', 'username', 'user', 'login', 'email', 'usernamefield'],
  password: ['loginpassword', 'password', 'pass', 'passwordfield'],
  url: ['loginuri', 'url', 'uri', 'website', 'site', 'loginurl', 'hostname'],
  notes: ['notes', 'note', 'comment', 'extra'],
  totp: ['logintotp', 'totp', 'otpauth', 'otpsecret', 'otpurl', 'authkey', 'twofactor', 'otp'],
};

function normalise(header: string): string {
  return header.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Guess which column is which.
 *
 * A guess, and the interface says so: the mapping is shown and can be changed
 * before anything is imported. Getting `username` and `email` the wrong way
 * round is the kind of mistake that is invisible afterwards and annoying for
 * years.
 */
export function detectColumns(header: CsvRow): ColumnMapping {
  const normalised = header.map(normalise);
  const mapping: ColumnMapping = {};

  for (const [field, candidates] of Object.entries(HEADERS) as [ImportField, string[]][]) {
    for (const candidate of candidates) {
      const index = normalised.indexOf(candidate);
      if (index !== -1) {
        mapping[field] = index;
        break;
      }
    }
  }

  return mapping;
}

export interface ImportedItem {
  readonly title: string;
  readonly username?: string;
  readonly password?: string;
  readonly url?: string;
  readonly notes?: string;
  readonly totp?: string;
}

export interface CsvImport {
  readonly items: ImportedItem[];
  /** Rows where every field but the title was empty, so there was nothing to store. */
  readonly skipped: number;
}

/**
 * Turn rows into items, given a mapping.
 *
 * A row is skipped when there is nothing in it to store: every exporter emits
 * blank lines and section markers, and an item called "" with nothing in it is
 * worse than no item.
 *
 * "Nothing to store" means every mapped field except the title is empty — not
 * just the password. Several exporters put their non-login entries in the same
 * file: NordPass writes credit cards, Proton writes its own types, and those
 * rows have a name and nothing else this app understands. Keeping them produced
 * a vault full of titles with no contents, which reads as an import that lost
 * the passwords rather than one that skipped a card.
 *
 * A note with no password is still kept, because its notes column is not empty.
 *
 * A row with a password but no title keeps the URL as its title, or failing
 * that the username. Refusing it would lose a password over a cosmetic problem.
 */
export function rowsToItems(rows: readonly CsvRow[], mapping: ColumnMapping): CsvImport {
  const items: ImportedItem[] = [];
  let skipped = 0;

  const at = (row: CsvRow, field: ImportField): string => {
    const index = mapping[field];
    if (index === undefined) return '';
    return (row[index] ?? '').trim();
  };

  for (const row of rows) {
    const title = at(row, 'title');
    const username = at(row, 'username');
    const password = at(row, 'password');
    const url = at(row, 'url');
    const notes = at(row, 'notes');
    const totp = at(row, 'totp');

    if (username === '' && password === '' && url === '' && notes === '' && totp === '') {
      skipped += 1;
      continue;
    }

    items.push({
      title: title || url || username || 'Untitled',
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(url ? { url } : {}),
      ...(notes ? { notes } : {}),
      ...(totp ? { totp } : {}),
    });
  }

  return { items, skipped };
}

/** Whether a mapping is usable at all. */
export function mappingIsUsable(mapping: ColumnMapping): boolean {
  // Without one of these there is nothing to store that anybody would recognise.
  return mapping.title !== undefined || mapping.password !== undefined;
}
