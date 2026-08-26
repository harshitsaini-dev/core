/// <reference lib="webworker" />

/**
 * Core's service worker.
 *
 * Written by hand rather than generated. Workbox is a fine library, but this
 * worker sits between a password manager and the network, and the rules it
 * enforces are short enough to read in one sitting — which is worth more here
 * than the convenience.
 *
 * The rules:
 *
 *   1. **API responses are never cached, ever.** Vault data is already stored
 *      locally in IndexedDB, encrypted twice. A second, unencrypted copy in the
 *      HTTP cache would undo that quietly and completely. Anything under /api
 *      goes straight to the network and its response is never written down.
 *
 *   2. **Navigations are network-first with a cached fallback.** Fresh HTML
 *      when there is a network, the last known good page when there is not.
 *      Cache-first would mean shipping a stale app after a deploy, which for
 *      a security tool means shipping a stale *fix*.
 *
 *   3. **Static assets are cache-first.** They are content-hashed, so a stale
 *      one is impossible by construction.
 */

const VERSION = 'v1';
const SHELL_CACHE = `core-shell-${VERSION}`;
const ASSET_CACHE = `core-assets-${VERSION}`;

/**
 * The pages worth having offline.
 *
 * Precaching is best-effort: a failure here must not abort the install, or a
 * single unreachable URL would leave the app with no worker at all.
 */
const SHELL = ['/', '/vault', '/login', '/signup', '/recover'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(SHELL.map((path) => cache.add(path)));
      // Take over promptly. A password manager holding a stale worker after an
      // update is exactly the case worth avoiding.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('core-') && !name.endsWith(VERSION))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

/**
 * A React Server Component payload.
 *
 * Next fetches one of these for every client-side navigation. They are not
 * `mode: navigate` requests and they are not static assets, so without this
 * they fell through every rule and simply failed offline — which made
 * navigating between pages impossible even though every page was cached. The
 * URL stays put, the new page never renders, and the symptom looks like a
 * hydration bug rather than a missing cache entry.
 */
function isRscRequest(request, url) {
  return request.headers.get('RSC') === '1' || url.searchParams.has('_rsc');
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    /\.(?:png|svg|ico|webmanifest|woff2?|css|js)$/.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET is ever cacheable, and only same-origin.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Rule 1. Not intercepted at all: no caching, no fallback, no offline reply.
  // A stale "you have no items" answered from a cache would be worse than a
  // visible failure.
  if (isApiRequest(url)) return;

  if (request.mode === 'navigate' || isRscRequest(request, url)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
  }
});

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);

    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    // Ignore the search string when matching: an RSC request carries a cache
    // buster in `_rsc` that differs every time, so an exact match would never
    // hit even when the payload is right there.
    const cached =
      (await caches.match(request)) ??
      (await caches.match(request, { ignoreSearch: true })) ??
      (await caches.match('/vault'));
    if (cached) return cached;

    return new Response(
      '<!doctype html><meta charset="utf-8"><title>core — offline</title>' +
        '<body style="background:#000;color:#00ff41;font-family:ui-monospace,monospace;padding:2rem">' +
        '<p>$ core</p><p>&gt; offline, and this page was never cached.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

/**
 * Cache assets the page reports having loaded.
 *
 * A precache list cannot name content-hashed chunks, and in development the
 * names change on every compilation. So the page sends the list instead: after
 * load it enumerates what it actually fetched and asks for those to be kept.
 *
 * This is what makes offline *hydration* work, as opposed to merely showing
 * cached HTML. Without it the markup renders from cache, the scripts fail, and
 * the result is a page that looks right and does nothing — which is worse than
 * an honest offline message, because a form that silently ignores typing reads
 * as broken rather than as unavailable.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache-assets') return;

  const urls = Array.isArray(event.data.urls) ? event.data.urls : [];

  event.waitUntil(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      await Promise.allSettled(
        urls
          .filter((url) => {
            try {
              const parsed = new URL(url, self.location.origin);
              return parsed.origin === self.location.origin && !isApiRequest(parsed);
            } catch {
              return false;
            }
          })
          // `reload` so a stale entry is refreshed rather than re-stored.
          .map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      );
    })(),
  );
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}
