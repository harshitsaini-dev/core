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
      size?: 'normal' | 'flexible' | 'compact';
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
 * Which widget fits the space there is.
 *
 * `flexible` fills its container and needs 300px to do it. `compact` is 150px
 * wide and fits anywhere. The default, `normal`, is a fixed 300px iframe — on a
 * phone the login panel is narrower than that (262px of content on a 360px
 * screen) so the default spilled out of the box it was in.
 *
 * Decided from the element's measured width rather than the viewport, because
 * what matters is the space this widget actually has and the padding around it
 * can change without this file knowing.
 */
export function widgetSize(available: number): 'flexible' | 'compact' {
  return available >= 300 ? 'flexible' : 'compact';
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

  /*
   * Sized to the space there actually is.
   *
   * The default widget is a fixed 300px iframe. A phone panel is narrower than
   * that — 262px of content on a 360px screen — so the default spills out of
   * the box it is in, which is what it did.
   *
   * `flexible` fills the container and needs 300px to do it; `compact` is
   * 150px wide and fits anywhere. Measured rather than guessed from the
   * viewport, because what matters is the element's own width and the padding
   * around it can change without this file knowing.
   */
  const size = widgetSize(element.getBoundingClientRect().width);

  /*
   * Clear whatever is in the container before rendering into it.
   *
   * Turnstile refuses a second widget in the same element — "Turnstile has
   * already been rendered in this container. The render attempt was rejected"
   * — and returns nothing, leaving a caller holding an id that is not one.
   *
   * It happens whenever the effect runs twice against the same node, which
   * React does on purpose in development and which a re-render can do at any
   * time. Emptying the element first makes the second attempt the only one that
   * matters, rather than the one that silently does nothing.
   */
  element.replaceChildren();

  const id = api.render(element, {
    sitekey: key,
    theme: 'dark',
    size,
    /*
     * Shown only when it has something to ask.
     *
     * Turnstile decides most visitors are fine without any interaction, and
     * with `always` it draws a box saying so — a grey-and-orange panel in the
     * middle of a black-and-green terminal, which is the one thing on the
     * screen that cannot be styled to match, because it is a cross-origin
     * iframe.
     *
     * `interaction-only` runs the same check and renders nothing unless a
     * person actually has to do something. When that happens the widget
     * appears, which is honest: at that point there genuinely is a question to
     * answer.
     */
    appearance: 'interaction-only',
    callback: (token) => onToken(token),
    // A widget that failed or expired must clear the token it gave earlier,
    // or the form stays enabled holding something the server will refuse.
    'error-callback': () => onToken(null),
    'expired-callback': () => onToken(null),
  });

  /*
   * `render` hands back nothing when it declined the container, so there is no
   * widget and nothing to reset.
   *
   * Not load-bearing, and said so rather than left looking like it is: the
   * `try` below already swallows what `reset(undefined)` throws, and removing
   * this line breaks no test. It stays because "there was never a widget" is a
   * known state rather than an exception, and treating it as one would mean the
   * ordinary case ran through a catch block.
   */
  if (id === undefined || id === null) return () => onToken(null);

  return () => {
    onToken(null);

    /*
     * `reset` throws, and the throw was killing the whole application.
     *
     * Turnstile raises `TurnstileError: Nothing to reset found for provided
     * container` when the widget is not where it expects — the element has
     * already been unmounted, or the widget never rendered because the script
     * refused the domain, or React ran the effect twice in development and the
     * second render was rejected. Nothing here is exceptional; all of them mean
     * "there is nothing to reset", which is exactly the state a teardown wants.
     *
     * Uncaught, it reached React as an error during an effect and the root
     * boundary replaced the page with "core could not start". That is how it
     * was found: intermittent 500 screens in the suite with no matching 500 in
     * the dev server log, because the server was never involved.
     */
    try {
      api.reset(id);
    } catch {
      // Already gone. That is the outcome this function wanted.
    }
  };
}

/**
 * Wait for a token that is on its way.
 *
 * With the widget hidden until it has something to ask, there is nothing on
 * screen saying a check is running — so somebody who presses the button a
 * second after the page loads submits without a token and is told to complete
 * a check they cannot see. That happened.
 *
 * Polled rather than wired through a promise the gate hands out, because the
 * token can arrive, be spent, and arrive again; a one-shot promise would be
 * resolved once and useless on the second attempt.
 *
 * The timeout is the important part. If the script was blocked — an ad
 * blocker, a filtered network — no token is ever coming, and the server fails
 * open for exactly that case. Waiting forever would turn a check that is
 * designed to get out of the way into the thing standing in the way.
 */
export async function waitForToken(
  read: () => string | null,
  timeoutMs = 8000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const token = read();
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
}
