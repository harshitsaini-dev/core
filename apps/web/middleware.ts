import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Security headers, and the Content Security Policy in particular.
 *
 * For a zero-knowledge product this is not one hardening measure among many.
 * The whole design rests on the master key never leaving the browser, and the
 * one thing that can take it is script running in this origin. Every other
 * protection here — the encryption, the wrapped keys, the non-extractable
 * CryptoKeys — assumes the page has not been turned against the user.
 *
 * So the directive that matters most is `connect-src 'self'`. An injected
 * script can still read what the page holds, but it cannot post it anywhere:
 * no fetch, no XHR, no WebSocket, no beacon to an attacker's server. That turns
 * a total compromise into a local one, which is a large difference.
 *
 * Set in middleware rather than `next.config.ts` because the nonce has to be
 * generated per request. A nonce reused across responses is decorative.
 */

/** Directives that never change between requests. */
function policy(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",

    // `strict-dynamic` lets a nonced script load the chunks it needs without
    // every hashed filename being listed. Without it, a nonce-based policy and
    // a code-split app are close to incompatible.
    //
    // `wasm-unsafe-eval` is not optional here, despite the name. Argon2id runs
    // as WebAssembly, and without this the browser refuses to instantiate it —
    // which means no key derivation, so no signup, no unlock and no recovery.
    // Development hid this behind `unsafe-eval`, which permits WebAssembly as a
    // side effect; the first build without it could not create an account.
    //
    // It is a far narrower grant than `unsafe-eval`: it allows compiling
    // WebAssembly and nothing else. No `eval`, no `new Function`, no string
    // timers.
    //
    // `unsafe-eval` itself is development only, for the dev server's HMR
    // client, and shipping it would leave the widest hole in an otherwise
    // strict policy.
    isDev
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' 'unsafe-eval'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,

    // Styles keep `unsafe-inline`, and that is a real weakness stated rather
    // than hidden. React and Next both inject inline styles, and nonce-ing
    // every one of them is not currently possible through the framework.
    // Injected CSS can do damage — background-image URLs can exfiltrate, and
    // an overlay can phish — but it cannot read a CryptoKey, which is the
    // property this product actually depends on.
    "style-src 'self' 'unsafe-inline'",

    "img-src 'self' data: blob:",
    "font-src 'self'",

    // The one that matters most. Same-origin only: nothing this page holds can
    // be posted anywhere else.
    "connect-src 'self'",

    // No plugins, no embedded content, and nothing may frame this page —
    // clickjacking a vault is a real attack, not a theoretical one.
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",

    // Restricts where a nonced script can navigate the top level, which closes
    // the "redirect to a lookalike and collect the master password" path.
    "base-uri 'self'",
    "form-action 'self'",

    // The Emergency Kit is printed from this page; nothing else is embedded.
    "media-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ];

  if (!isDev) {
    // Only meaningful over HTTPS, and it would break a plain-HTTP localhost.
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV === 'development';

  // 128 bits, base64. Regenerated per request; a shared nonce is no nonce.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

  const headers = new Headers(request.headers);
  // Next reads this to stamp the nonce onto the scripts it emits.
  headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });

  response.headers.set('Content-Security-Policy', policy(nonce, isDev));

  // Each of these is set here and nowhere else. Setting the same header in
  // next.config.ts as well appended rather than replaced on the Workers
  // runtime, producing `X-Frame-Options: DENY, DENY` — valid-looking, and
  // rejected as malformed by anything strict about parsing it.
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Permissions-Policy',
    // Nothing here needs a camera, a microphone or a location, and a vault is
    // a poor place to leave those available to injected script.
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );

  // Isolates this origin from other windows, so a page that opens Core cannot
  // reach into it through `window.opener`.
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  if (!isDev) {
    // Two years, subdomains included. Preload is deliberately omitted until the
    // domain has been served over HTTPS long enough to be confident: getting
    // onto the preload list is easy and getting off it is not.
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  return response;
}

export const config = {
  /*
   * Documents only.
   *
   * `_next/static` is content-hashed and immutable, and running middleware for
   * each chunk would add a nonce nothing reads to hundreds of responses per
   * page load.
   *
   * `sw.js` is excluded because a nonce-based `script-src` on the service
   * worker's own response stops the worker executing — it has no nonce, and it
   * is not loaded by anything that could give it one. The symptom is not a CSP
   * error but a silently unregistered worker, which shows up much later as the
   * app failing to open offline.
   *
   * `/api` is excluded for a second and better reason. A JSON response has no
   * scripts, so a script policy on it protects nothing — and the auth routes
   * pad themselves to a fixed duration to hide whether an account exists.
   * Middleware runs outside that padding, so every millisecond it costs is
   * variance the padding cannot absorb. It showed up as the prelogin timing
   * assertion drifting from under 5ms to 9ms.
   */
  matcher: [
    '/((?!api|sw[.]js|_next/static|_next/image|favicon[.]ico|.*[.](?:png|svg|ico|webmanifest)$).*)',
  ],
};
