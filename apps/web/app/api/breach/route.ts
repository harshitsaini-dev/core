import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';

/**
 * The breach check, proxied.
 *
 * Have I Been Pwned's range API answers with every leaked hash sharing a
 * five-character SHA-1 prefix, so the caller learns whether a password appears
 * in a breach without ever sending it. That part is sound and is why the
 * feature is possible at all in a product like this.
 *
 * The proxy exists for the other half. Calling the API from the browser would
 * mean widening `connect-src` — the one directive this product leans on hardest
 * — to a third-party host, permanently, for everybody, including the people who
 * never switch the feature on. An injected script could not read a CryptoKey
 * either way, but the policy would no longer say "nothing this page holds goes
 * anywhere else", and that sentence is worth keeping true.
 *
 * The cost is that this server sees the prefix. That is five hex characters:
 * one bucket in about a million, shared by every password whose hash starts the
 * same way, identifying nothing. Weighed against a server that already sees the
 * IP, the timing and the size of the vault, it is a small addition — and it is
 * a fair trade for leaving the strongest line of the CSP alone.
 *
 * Session-gated, so this is not an open proxy for anybody who finds the URL.
 */

/** Exactly five hex characters, which is what the range API takes. */
const PREFIX = /^[0-9a-fA-F]{5}$/;

export async function GET(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const retryAfter = await checkLimit(
    request,
    context.kv,
    context.pepper,
    'sync',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  const prefix = new URL(request.url).searchParams.get('prefix');
  if (!prefix || !PREFIX.test(prefix)) return badRequest();

  let upstream: Response;
  try {
    upstream = await fetch(`https://api.pwnedpasswords.com/range/${prefix.toUpperCase()}`, {
      headers: {
        // Pads the answer with random entries so its size says nothing about
        // how many real matches there were. Without it the response length is
        // a side channel back to the prefix.
        'Add-Padding': 'true',
      },
    });
  } catch {
    // The check is an extra, not a dependency. A vault must not become less
    // usable because a third party is down.
    return new Response('', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!upstream.ok) {
    return new Response('', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Public and long-lived on purpose: the answer for a prefix is the same
      // for everybody and changes only when the corpus does, so caching it is
      // both free and one fewer round trip per repeated prefix.
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
