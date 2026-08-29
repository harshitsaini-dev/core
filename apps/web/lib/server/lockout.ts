import { LIMITS } from './rate-limit';

/**
 * When an account locks, and for how long.
 *
 * Here rather than in the login route because three other places describe this
 * to a person — the alert email, the unlock email, and the screen — and every
 * one of them had the number written out in words. Changing the threshold from
 * ten to five left all three saying "ten", which is worse than saying nothing:
 * somebody reading "ten sign-in attempts failed" after five would reasonably
 * conclude somebody else had been trying.
 */

/**
 * Failures before an account locks.
 *
 * Tied to the login bucket's capacity, and it has to be. The limiter refuses a
 * caller after that many attempts in a minute and a refusal never reaches the
 * counter — so a threshold above the bucket is one a single caller can never
 * reach. It was ten against a bucket of five, which meant the lockout fired
 * only for an attacker spread across enough addresses to keep every bucket
 * alive, and never for anybody else.
 */
export const LOCKOUT_THRESHOLD = LIMITS.login.capacity;

/** How long a lock lasts. It expires on its own; nobody is ever stranded. */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Numbers as words, far enough to cover both values above.
 *
 * Far enough matters: the list stopped at ten, so a fifteen-minute window came
 * out as the numeral "15" in the middle of a sentence that said "fifteen"
 * everywhere else. A test now holds the range rather than trusting the list to
 * be long enough.
 */
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

/** The threshold as a word, for prose that should not contain a numeral. */
export function thresholdInWords(): string {
  return WORDS[LOCKOUT_THRESHOLD] ?? String(LOCKOUT_THRESHOLD);
}

/** The window in minutes, as a word, for the same reason. */
export function windowInWords(): string {
  const minutes = Math.round(LOCKOUT_WINDOW_MS / 60_000);
  return WORDS[minutes] ?? `${minutes}`;
}
