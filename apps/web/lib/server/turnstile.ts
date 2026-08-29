import type { NextRequest } from 'next/server';

/**
 * Turnstile, on the endpoints where a script is the problem.
 *
 * The rate limiter already counts requests per address and the lockout already
 * stops guessing at one account. Neither helps against the thing this is for:
 * a thousand addresses each making three requests, which no per-caller counter
 * sees as anything but a thousand ordinary people.
 *
 * **Off unless configured, and that is not a stub.** An instance with no secret
 * key is a self-hosted instance behind whatever its owner already has, and
 * refusing to start would make bot protection a requirement for running your
 * own copy. The rate limiter and the lockout are still there either way.
 *
 * One consequence worth knowing before changing this: with a secret key set,
 * every request arriving without a token is refused — including every request
 * the browser test suite makes, since an API-level test cannot solve a
 * challenge. The suite therefore runs with this off and the behaviour here is
 * covered by unit tests instead. `.dev.vars.example` says the same thing where
 * somebody configuring an instance will actually read it.
 *
 * Failing open on a network error is the same decision the limiter makes for
 * the same reason: this sits in front of sign-in, and an instance that stops
 * accepting logins because Cloudflare had a bad minute has done more damage
 * than the bots it was holding off.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The header the widget's token arrives in. */
export const TURNSTILE_HEADER = 'cf-turnstile-response';

export interface TurnstileConfig {
  readonly secretKey: string | undefined;
}

export function turnstileEnabled(config: TurnstileConfig): boolean {
  return Boolean(config.secretKey);
}

/**
 * Whether this request carries a token Cloudflare accepts.
 *
 * `true` when the feature is off, so a caller reads as "not refused" rather
 * than having to know whether it is configured.
 */
export async function verifyTurnstile(
  config: TurnstileConfig,
  request: NextRequest,
): Promise<boolean> {
  if (!turnstileEnabled(config)) return true;

  const token = request.headers.get(TURNSTILE_HEADER);
  if (!token) return false;

  try {
    const body = new FormData();
    body.append('secret', config.secretKey ?? '');
    body.append('response', token);

    // The caller's address, so a token solved for one visitor cannot be
    // replayed from somewhere else. Omitted when the header is absent rather
    // than guessed, since a wrong address fails a token that was fine.
    const address = request.headers.get('cf-connecting-ip');
    if (address) body.append('remoteip', address);

    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`turnstile verify answered ${response.status}; allowing the request`);
      return true;
    }

    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    // Fails open. See the note at the top: an instance that stops accepting
    // logins because a verification service was unreachable has done more
    // damage than the bots it was holding off.
    console.warn('turnstile verify was unreachable; allowing the request');
    return true;
  }
}
