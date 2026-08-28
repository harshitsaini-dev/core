import {
  bytesToBase64Url,
  bytesToHex,
  randomBytes,
  randomChoice,
  randomInt,
  shuffleInPlace,
} from '@core/crypto';

/**
 * Password and passphrase generation.
 *
 * Built on `@core/crypto`'s unbiased helpers rather than `Math.random`, which
 * is worth stating because this is exactly the place a plausible-looking
 * shortcut does invisible damage: a biased generator produces passwords that
 * look fine and are weaker than their length suggests.
 */

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

/**
 * Ambiguous characters are excluded from the sets above: no l, I, 1, O or 0.
 *
 * The entropy cost is under a tenth of a bit per character. The benefit is that
 * somebody reading a generated password off a printed Emergency Kit, or across
 * a room, does not silently get it wrong — and this project has a printed kit.
 */

export interface PasswordOptions {
  length?: number;
  uppercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

export function generatePassword({
  length = 20,
  uppercase = true,
  digits = true,
  symbols = true,
}: PasswordOptions = {}): string {
  const pools = [LOWER];
  if (uppercase) pools.push(UPPER);
  if (digits) pools.push(DIGITS);
  if (symbols) pools.push(SYMBOLS);

  const alphabet = pools.join('');
  const characters: string[] = [];

  // One from each enabled pool first, so a generated password always satisfies
  // the composition rules sites impose. Without this, a run that happens to
  // contain no digit gets rejected at signup and the user regenerates until it
  // does, which is slower and no stronger.
  for (const pool of pools) {
    characters.push(randomChoice([...pool]));
  }

  while (characters.length < Math.max(length, pools.length)) {
    characters.push(randomChoice([...alphabet]));
  }

  // Shuffled, because otherwise the guaranteed characters sit in a fixed order
  // at the front and an attacker knows the first four positions by pool.
  return shuffleInPlace(characters).join('');
}

/**
 * A short, memorable word list.
 *
 * Deliberately small and inlined rather than pulling in a full diceware list:
 * this generates a passphrase somebody has to type from a printed page, and the
 * words are chosen to be short, unambiguous and hard to mishear. A real
 * diceware list is 7776 words and about 60 KB, which is a poor trade on a page
 * a phone loads before it can show anything.
 *
 * With 256 words, four words give 32 bits — weak alone, which is why the
 * default is six (48 bits) and why the strength meter still has the last word.
 */
// prettier-ignore
const WORDS = [
  'amber','anchor','apple','arrow','atlas','autumn','bacon','badge','basil','beacon',
  'birch','bishop','bison','blade','bloom','bolt','bonus','brave','bread','brick',
  'bridge','bronze','brush','cabin','cable','cactus','camel','candle','canvas','carbon',
  'cargo','castle','cedar','chalk','charm','cheese','cherry','chess','cider','cinder',
  'circus','clay','cliff','cloud','clover','cobalt','cocoa','comet','copper','coral',
  'cotton','cradle','crane','crater','crimson','crystal','cube','dagger','daisy','dawn',
  'delta','denim','desert','diamond','dolphin','domino','draft','dragon','dune','eagle',
  'ember','emerald','engine','envoy','falcon','fable','fern','fiber','fiddle','flame',
  'flint','flute','forest','fossil','fox','frost','galaxy','garden','gate','ginger',
  'glacier','globe','granite','grape','gravel','grove','hammer','harbor','harvest','hazel',
  'helmet','hollow','honey','hornet','ice','indigo','ivory','jade','jasmine','jetty',
  'jungle','kettle','keystone','lagoon','lantern','laurel','ledger','lemon','lily','linen',
  'lobby','locket','lotus','lumber','lunar','magnet','mango','maple','marble','marsh',
  'meadow','melon','mercury','meteor','midnight','mint','mirror','mosaic','moss','motor',
  'muffin','nectar','needle','nickel','noble','nomad','oak','oasis','ocean','olive',
  'onyx','opal','orbit','orchid','otter','oyster','paddle','palace','pantry','papaya',
  'parcel','pastel','pebble','pelican','pepper','pewter','phantom','pigeon','pilot','pine',
  'piston','pixel','planet','plaza','plum','pocket','pollen','poppy','portal','prairie',
  'prism','pueblo','pumpkin','quartz','quiver','radar','raven','ribbon','ridge','river',
  'rocket','rooster','rosemary','rubble','ruby','saffron','sage','salmon','sandal','sapphire',
  'satin','scarlet','sculpt','seagull','sequoia','shadow','shamrock','shelter','sherbet','shield',
  'shovel','signal','silver','siren','sketch','slate','sleigh','socket','solar','sonnet',
  'spark','sphere','spice','spiral','sprout','squid','stable','stellar','stone','storm',
  'stream','stucco','summit','sunset','syrup','tangle','tapestry','teapot','tender','thicket',
  'thistle','thunder','tiger','timber','tonic','topaz','torch','totem','tower','trellis',
  'trumpet','tulip','tundra','turtle','umber','urchin','valley','velvet','vessel','violet',
  'walnut','wander','willow','window','winter',
] as const;

export function generatePassphrase(words = 6, separator = '-'): string {
  return Array.from({ length: Math.max(3, words) }, () => randomChoice(WORDS)).join(separator);
}

/** A random API key. The utility developers reach for constantly. */
export function generateApiKey(bytes = 32): string {
  const alphabet = `${LOWER}${UPPER}${DIGITS}`;
  return Array.from({ length: bytes }, () => alphabet[randomInt(alphabet.length)]).join('');
}

/**
 * A UUID.
 *
 * `crypto.randomUUID` where it exists, which is everywhere this app runs, and a
 * hand-built v4 where it does not — a page served over plain HTTP in a browser
 * that gates it on a secure context. That fallback is not a security
 * compromise: it draws from the same CSPRNG and only assembles the bytes here.
 */
export function generateUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = randomBytes(16);
  // Version 4, variant 10xx. Written out because a UUID that fails a strict
  // parser is a UUID that gets rejected somewhere far from here.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytesToHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Random hex. The shape a secret is usually wanted in for a config file. */
export function generateHex(bytes = 32): string {
  return bytesToHex(randomBytes(bytes));
}

/**
 * Random base64url.
 *
 * url-safe rather than standard base64, because these end up in `.env` files
 * and query strings, and a `+` or `/` in either is a bug found later by
 * somebody else.
 */
export function generateBase64(bytes = 32): string {
  return bytesToBase64Url(randomBytes(bytes));
}
