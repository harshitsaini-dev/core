'use client';

import { buttonClasses } from '@core/ui';
import { useEffect, useState } from 'react';

/**
 * Install this as an app.
 *
 * Rendered only when the browser says it can be installed, and that is the
 * whole design of this component. Chrome fires `beforeinstallprompt` when a
 * page meets the installability criteria and has not already been installed —
 * so a button that appears only in response to it is a button that is never a
 * lie.
 *
 * The alternative, which most sites do, is a permanent "Install app" that does
 * nothing on the browsers that cannot, and offers to install something already
 * installed on the ones that can. For a password manager the first impression
 * is the whole trust budget; a button that does nothing spends it.
 *
 * Safari has no such event. There is no button on iOS rather than a wrong one:
 * installing there is Share → Add to Home Screen, and a page that cannot detect
 * whether that has already happened should not be nagging about it.
 */

/** The event Chrome fires, which TypeScript's DOM library does not describe. */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event): void => {
      // Held rather than let through: without this Chrome shows its own bar at
      // a moment of its choosing, and the button below would then be a second
      // way to ask for the same thing.
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };

    // Once installed the event never fires again, so the button disappears on
    // its own without anything having to track that.
    const onInstalled = (): void => setPrompt(null);

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!prompt) return null;

  return (
    <button
      type="button"
      className={buttonClasses('ghost')}
      data-testid="install-app"
      onClick={() => {
        void prompt.prompt();
        // Spent either way. A dismissed prompt cannot be shown again from the
        // same event, and leaving the button up would give somebody a control
        // that silently stops working.
        setPrompt(null);
      }}
    >
      install
    </button>
  );
}
