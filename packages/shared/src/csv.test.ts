import { describe, expect, it } from 'vitest';
import { detectColumns, mappingIsUsable, parseCsv, rowsToItems } from './csv';

/**
 * The CSV importer.
 *
 * What it parses is somebody's entire password vault, exported in the clear.
 * Every row it drops is a password they will not find out is missing until they
 * need it, so the tests are mostly about not losing rows.
 */

describe('parseCsv', () => {
  it('reads the ordinary case', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma inside quotes', () => {
    expect(parseCsv('name,notes\nBank,"one, two"')[1]).toEqual(['Bank', 'one, two']);
  });

  it('keeps a newline inside quotes', () => {
    // A Bitwarden export puts multi-line notes in quoted fields. Splitting on
    // newlines first turns one item into six broken ones.
    const rows = parseCsv('name,notes\nBank,"line one\nline two"');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe('line one\nline two');
  });

  it('reads a doubled quote as one quote', () => {
    expect(parseCsv('a\n"say ""hello"""')[1]?.[0]).toBe('say "hello"');
  });

  it('keeps an empty field', () => {
    expect(parseCsv('a,b,c\n1,,3')[1]).toEqual(['1', '', '3']);
  });

  it('survives a file written on Windows', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('does not invent a row from a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
  });

  it('reads a password that is nothing but quotes and commas', () => {
    // Generated passwords contain exactly the characters a naive split breaks
    // on, and this is the row somebody notices last.
    const rows = parseCsv('name,password\nX,",,,""hi"","');
    expect(rows[1]?.[1]).toBe(',,,"hi",');
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('detectColumns', () => {
  it('reads a Bitwarden header', () => {
    const header = [
      'folder',
      'favorite',
      'type',
      'name',
      'notes',
      'fields',
      'login_uri',
      'login_username',
      'login_password',
      'login_totp',
    ];

    const mapping = detectColumns(header);
    expect(header[mapping.title ?? -1]).toBe('name');
    expect(header[mapping.username ?? -1]).toBe('login_username');
    expect(header[mapping.password ?? -1]).toBe('login_password');
    expect(header[mapping.totp ?? -1]).toBe('login_totp');
  });

  it('reads a Chrome header', () => {
    const header = ['name', 'url', 'username', 'password', 'note'];
    const mapping = detectColumns(header);

    expect(header[mapping.url ?? -1]).toBe('url');
    expect(header[mapping.password ?? -1]).toBe('password');
    expect(header[mapping.notes ?? -1]).toBe('note');
  });

  it('reads a LastPass header', () => {
    const header = ['url', 'username', 'password', 'totp', 'extra', 'name', 'grouping', 'fav'];
    const mapping = detectColumns(header);

    expect(header[mapping.title ?? -1]).toBe('name');
    expect(header[mapping.notes ?? -1]).toBe('extra');
  });

  it('ignores case and punctuation in a header', () => {
    const mapping = detectColumns(['Login URI', 'Login Username']);
    expect(mapping.url).toBe(0);
    expect(mapping.username).toBe(1);
  });

  it('prefers the more specific name when both are present', () => {
    // Bitwarden has both `notes` and `login_password`; picking `password` from
    // a column literally called `password` when `login_password` exists would
    // import the wrong one.
    const mapping = detectColumns(['password', 'login_password']);
    expect(mapping.password).toBe(1);
  });

  it('finds nothing in a header it does not recognise', () => {
    expect(detectColumns(['col1', 'col2'])).toEqual({});
  });
});

describe('rowsToItems', () => {
  const mapping = { title: 0, username: 1, password: 2, url: 3 };

  it('builds an item from a row', () => {
    const [item] = rowsToItems([['GitHub', 'me', 'secret', 'https://github.com']], mapping).items;

    expect(item).toEqual({
      title: 'GitHub',
      username: 'me',
      password: 'secret',
      url: 'https://github.com',
    });
  });

  it('drops the fields that are empty rather than storing blanks', () => {
    // An item recording `username: ""` reads back as though it has one.
    const [item] = rowsToItems([['GitHub', '', 'secret', '']], mapping).items;
    expect(item).toEqual({ title: 'GitHub', password: 'secret' });
  });

  it('skips a row with neither a title nor a password', () => {
    // Every exporter emits blank lines and section markers.
    const result = rowsToItems(
      [
        ['', '', '', ''],
        ['GitHub', '', 'secret', ''],
      ],
      mapping,
    );
    expect(result.items).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('skips a row that is only a title', () => {
    // NordPass writes credit cards into the same file as the logins, and Proton
    // writes its own types. Those rows have a name and nothing else this app
    // understands, and keeping them made a vault full of titles with no
    // contents — which reads as an import that lost the passwords.
    const result = rowsToItems(
      [
        ['Visa ending 4021', '', '', ''],
        ['GitHub', '', 'secret', ''],
      ],
      mapping,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('GitHub');
    expect(result.skipped).toBe(1);
  });

  it('keeps a note that has no password', () => {
    // The other side of the rule above. A titled row with something in any
    // field is worth keeping, and dropping it would lose real writing.
    const result = rowsToItems([['Wifi', '', '', '', 'the code is on the router']], {
      title: 0,
      username: 1,
      password: 2,
      url: 3,
      notes: 4,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({ title: 'Wifi', notes: 'the code is on the router' });
  });

  it('never drops a password over a missing title', () => {
    // Refusing the row would lose a password to a cosmetic problem.
    const result = rowsToItems([['', 'me', 'secret', 'https://example.com']], mapping);
    expect(result.items[0]?.title).toBe('https://example.com');
    expect(result.items[0]?.password).toBe('secret');
  });

  it('falls back to the username, then to something rather than nothing', () => {
    expect(rowsToItems([['', 'me', 'secret', '']], mapping).items[0]?.title).toBe('me');
    expect(rowsToItems([['', '', 'secret', '']], mapping).items[0]?.title).toBe('Untitled');
  });

  it('ignores a column the mapping does not name', () => {
    const result = rowsToItems([['GitHub', 'me', 'secret', 'x']], { title: 0, password: 2 });
    expect(result.items[0]).toEqual({ title: 'GitHub', password: 'secret' });
  });

  it('tolerates a row shorter than the header', () => {
    // Exports are ragged more often than they should be, and a missing trailing
    // column must not throw away the row.
    const result = rowsToItems([['GitHub', 'me']], mapping);
    expect(result.items[0]).toEqual({ title: 'GitHub', username: 'me' });
  });
});

describe('mappingIsUsable', () => {
  it('needs something recognisable to store', () => {
    expect(mappingIsUsable({})).toBe(false);
    expect(mappingIsUsable({ username: 0 })).toBe(false);
    expect(mappingIsUsable({ title: 0 })).toBe(true);
    expect(mappingIsUsable({ password: 1 })).toBe(true);
  });
  it('reads the headers the common exporters actually write', () => {
    // Checked against real export files rather than guessed. The mapping is
    // shown and editable, but a first guess that gets these wrong means
    // everybody remaps by hand, and the ones who do not notice import a vault
    // with the username and email the wrong way round.
    const cases: Record<string, string> = {
      chrome: 'name,url,username,password,note',
      safari: 'Title,URL,Username,Password,Notes,OTPAuth',
      lastpass: 'url,username,password,totp,extra,name,grouping,fav',
      onepassword: 'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes',
      bitwarden:
        'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      dashlane: 'username,username2,username3,title,password,note,url,category,otpSecret',
      nordpass: 'name,url,username,password,note,cardholdername,cardnumber,folder',
      proton: 'type,name,url,email,username,password,note,totp,createTime,vault',
      keepass: 'Group,Title,Username,Password,URL,Notes',
    };

    for (const [name, header] of Object.entries(cases)) {
      const mapped = detectColumns(header.split(','));
      expect(mapped.title, name).toBeDefined();
      expect(mapped.username, name).toBeDefined();
      expect(mapped.password, name).toBeDefined();
      expect(mapped.url, name).toBeDefined();
    }
  });

  it('finds the one-time code column whatever it is called', () => {
    // Each of these is a different exporter's spelling. Missing one loses the
    // second factor silently: the import reports success and the item simply
    // has no code.
    for (const header of ['totp', 'OTPAuth', 'otpSecret', 'login_totp', 'authkey']) {
      expect(detectColumns(['name', 'password', header]).totp, header).toBe(2);
    }
  });

  it('does not find a title where the exporter wrote none', () => {
    // Firefox exports no title column at all. Inventing one would be worse than
    // falling back to the URL, which is what `rowsToItems` does.
    const firefox = 'url,username,password,httpRealm,formActionOrigin,guid'.split(',');
    expect(detectColumns(firefox).title).toBeUndefined();

    const items = rowsToItems(
      [['https://example.com', 'me', 'secret', '', '', '']],
      detectColumns(firefox),
    );
    expect(items.items[0]?.title).toBe('https://example.com');
  });
});
