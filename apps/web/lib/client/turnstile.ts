'use client';

/**
 * The Turnstile widget, loaded only where it is needed.
 *
 * Two things shape this file.
 *
 * The script is third-party and this app's Content Security Policy is
 * `script-src 'self' 'nonce-…' 'strict-dynamic'`. `strict-dynamic` is what
 * makes loading it possible without naming a host in `script-src`: a script the
 * nonced bundle inserts is trusted because the bundle inserted it.
 *
 * That is not the whole story, and the first deployment found out how. The
 * widget itself is an **iframe**, and `strict-dynamic` says nothing about
 * framing — under `frame-src 'none'` the script loaded, the widget never
 * appeared, and the only trace was a console error. `middleware.ts` now allows
 * `challenges.cloudflare.com` in `frame-src`, and only when Turnstile is
 * configured. `frame-ancestors 'none'` — who may embed *this* page, which is
 * the clickjacking one — is untouched.
 *
 * And the whole thing is optional. With no site key configured there is no
 * widget, no script, and no request to Cloudflare — an instance without bot
 * protection makes no third-party calls on its sign-in page, which is the
 * behaviour a self-hoster who did not configure it would expect.
 */

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The header the token is sent back in. Matches the server. */
export const TURNSTILE_HEADER = 'cf-turnstile-response';

export function siteKey(): string | undefined {
  // Read as a whole expression rather than by index: Next replaces this text at
  // build time, and a dynamic lookup is not replaced at all.
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || undefined;
}

export function turnstileEnabled(): boolean {
  return Boolean(siteKey());
}

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      theme?: 'dark' | 'light' | 'auto';
      appearance?: 'always' | 'execute' | 'interaction-only';
    },
  ) => string;
  reset: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/**
 * Load the script once, however many forms ask for it.
 *
 * A cached promise rather than a cached value, so two forms mounting together
 * do not start two loads.
 */
function load(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('turnstile loaded without its API'));
    };
    script.onerror = () => reject(new Error('turnstile script did not load'));

    document.head.appendChild(script);
  });

  return loading;
}

/**
 * Render a widget into an element and resolve tokens through a callback.
 *
 * Returns a reset function. A token is single-use: once a form has submitted
 * one, the next submission needs a fresh one, and a form that reuses the old
 * one fails verification in a way that looks like the server rejecting the
 * password.
 */
export async function mountTurnstile(
  element: HTMLElement,
  onToken: (token: string | null) => void,
): Promise<() => void> {
  const key = siteKey();
  if (!key) return () => undefined;

  const api = await load();

  const id = api.render(element, {
    sitekey: key,
    theme: 'dark',
    callback: (token) => onToken(token),
    // A widget that failed or expired must clear the token it gave earlier,
    // or the form stays enabled holding something the server will refuse.
    'error-callback': () => onToken(null),
    'expired-callback': () => onToken(null),
  });

  return () => {
    onToken(null);
    api.reset(id);
  };
}
