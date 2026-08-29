'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from '@/lib/client/toast-store';

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

/**
 * Tell the page when a new version has taken over.
 *
 * The worker calls `skipWaiting`, so an update installs and claims the page
 * immediately rather than sitting in a waiting state — for a security tool, a
 * user parked on last week's build is worse than an interrupted one. What that
 * does not do is replace the JavaScript already running, which keeps going
 * until a reload.
 *
 * So there is no "an update is waiting" prompt to show; there is a "the update
 * is already here, this tab is the old one" prompt, which is the honest version
 * of the same thing. It is a toast with an action rather than an automatic
 * reload: reloading a vault out from under somebody mid-edit would lose what
 * they were typing, and the keys with it.
 */
function watchForUpdates(): () => void {
  const container = navigator.serviceWorker;
  if (!container) return () => undefined;

  // `controllerchange` also fires the first time a worker takes control of a
  // page that had none, which is an install and not an update. Only a change
  // *from* an existing controller is worth interrupting somebody for.
  let had = container.controller !== null;

  const onChange = (): void => {
    if (had) {
      toast('A new version of core is ready.', {
        action: { label: 'reload', run: () => window.location.reload() },
      });
    }
    had = true;
  };

  container.addEventListener('controllerchange', onChange);
  return () => container.removeEventListener('controllerchange', onChange);
}

export function ServiceWorker() {
  const pathname = usePathname();

  useEffect(() => watchForUpdates(), []);

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
