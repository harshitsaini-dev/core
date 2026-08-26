import { ZxcvbnFactory } from '@zxcvbn-ts/core';

/**
 * Master-password strength estimation.
 *
 * This is the only thing standing between a user and a vault they cannot
 * protect. Argon2id makes each guess expensive, but no key derivation saves a
 * password that appears in a wordlist — so the meter is not decoration, and the
 * signup form treats a weak score as a hard stop rather than a suggestion.
 */

/**
 * Built once, on first use, and reused.
 *
 * The dictionaries are imported dynamically rather than statically because they
 * are roughly 800 KB — larger than the rest of the application put together.
 * Bundling them into the signup page would make the first paint of a
 * mobile-first PWA wait on a wordlist that is not needed until the user starts
 * typing a password.
 *
 * Rebuilding the matcher per keystroke would also make the meter the slowest
 * thing on the page, hence the cached promise rather than a cached value: two
 * quick keystrokes must not start two loads.
 */
let building: Promise<ZxcvbnFactory> | undefined;

function estimator(): Promise<ZxcvbnFactory> {
  building ??= (async () => {
    const [common, en] = await Promise.all([
      import('@zxcvbn-ts/language-common'),
      import('@zxcvbn-ts/language-en'),
    ]);

    return new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
  })();

  return building;
}

export interface Strength {
  /** 0 (terrible) to 4 (strong). */
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly label: string;
  /** zxcvbn's own feedback, when it has something specific to say. */
  readonly warning: string;
  readonly suggestions: readonly string[];
  /** Order-of-magnitude guesses at an offline attack rate. */
  readonly crackTime: string;
}

const LABELS = ['unusable', 'weak', 'fair', 'good', 'strong'] as const;

/** The lowest score signup will accept. */
export const MINIMUM_SCORE = 3;

export async function estimate(password: string, userInputs: string[] = []): Promise<Strength> {
  const zxcvbn = await estimator();
  const result = await zxcvbn.checkAsync(password, userInputs);

  const score = result.score as 0 | 1 | 2 | 3 | 4;

  return {
    score,
    label: LABELS[score] ?? 'unusable',
    warning: result.feedback.warning ?? '',
    suggestions: result.feedback.suggestions ?? [],
    // The slow-hash figure, not the online one: the threat here is somebody
    // with the database and a GPU, not somebody typing at a login form.
    crackTime: result.crackTimes.offlineSlowHashingXPerSecond.display,
  };
}
