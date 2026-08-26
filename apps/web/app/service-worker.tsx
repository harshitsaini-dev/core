'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Register the service worker and keep it told what the app has loaded.
 *
 * Registered in development as well as production. Offline behaviour is the
 * feature under test in this phase, and a worker that only exists in production
 * builds is a worker nobody exercises until it is too late to notice it is
 * wrong.
 */

/**
 * Report every same-origin resource this page has fetched.
 *
 * Done on each route change, not only on first load. Client-side navigation
 * pulls in the next route's chunks without firing `load`, so reporting once at
 * startup caches the entry page and quietly misses every page reached from it —
 * which shows up much later as one screen that works offline and the rest that
 * do not.
 */
function reportAssets(): void {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return;

  const urls = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter((entry) => entry.initiatorType === 'script' || entry.initiatorType === 'link')
    .map((entry) => entry.name);

  if (urls.length > 0) {
    controller.postMessage({ type: 'cache-assets', urls });
  }
}

export function ServiceWorker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      void navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(() => navigator.serviceWorker.ready)
        .then(() => reportAssets())
        .catch(() => {
          // Refused on insecure origins other than localhost, and in some
          // private browsing modes. The app still works; only offline use is
          // lost, and there is nothing useful to tell the user about that.
        });
    };

    if (document.readyState === 'complete') {
      register();
      return undefined;
    }

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // Reported twice: once now, and once after the route's own chunks have had
    // time to arrive. Waiting only for the second would miss a page the user
    // passes straight through — the login screen between signup and the vault
    // is exactly that, and it is the one they come back to offline.
    reportAssets();
    const timer = setTimeout(reportAssets, 1000);
    return () => clearTimeout(timer);
  }, [pathname]);

  return null;
}
