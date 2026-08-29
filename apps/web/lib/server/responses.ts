import { NextResponse } from 'next/server';

/**
 * Response helpers for authentication endpoints.
 *
 * Every failure on an auth path returns the *same* body and the same status,
 * regardless of cause. "User not found", "wrong password" and "malformed
 * request" are indistinguishable to a caller, because telling them apart is
 * exactly what an attacker enumerating accounts wants to do.
 *
 * Detail goes to the server log, never to the client.
 */

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
} as const;

export function ok<T extends object>(body: T): NextResponse {
  return NextResponse.json(body, { status: 200, headers: NO_STORE });
}

/** The single generic failure. Use this for every auth rejection. */
export function authFailure(): NextResponse {
  return NextResponse.json(
    { error: 'invalid_credentials', message: 'Invalid credentials.' },
    { status: 401, headers: NO_STORE },
  );
}

/** Malformed input. Safe to distinguish: it says nothing about any account. */
export function badRequest(): NextResponse {
  return NextResponse.json(
    { error: 'bad_request', message: 'Malformed request.' },
    { status: 400, headers: NO_STORE },
  );
}

/**
 * The bot check was not satisfied.
 *
 * Distinct from a malformed request because the caller can do something about
 * this one, and from a failed sign-in because their password was never looked
 * at. Reported as its own thing so the screen can say what actually happened —
 * a form that answers "those credentials did not work" to somebody who has not
 * finished a checkbox is telling them the one thing that is not true.
 *
 * It leaks nothing: it describes this request, not the account.
 */
export function botCheckFailed(): NextResponse {
  return NextResponse.json(
    { error: 'bot_check', message: 'Complete the bot check and try again.' },
    { status: 400, headers: NO_STORE },
  );
}

export function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: 'rate_limited', message: 'Too many attempts. Try again later.' },
    {
      status: 429,
      headers: { ...NO_STORE, 'Retry-After': String(retryAfterSeconds) },
    },
  );
}

export function serverError(): NextResponse {
  return NextResponse.json(
    { error: 'server_error', message: 'Something went wrong.' },
    { status: 500, headers: NO_STORE },
  );
}
