'use client';

import { Panel } from '@core/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

/**
 * The page an unlock link lands on.
 *
 * It lifts a lockout and nothing else. Nobody is signed in here, no key is
 * derived, and the next screen is the ordinary sign-in form — which is the
 * whole reason a link like this is safe to put in an email.
 *
 * Said out loud on the page, too. "Unlocked" next to a vault means something
 * else in this product, and somebody arriving from a security email deserves to
 * know which one happened.
 */

type State = 'working' | 'done' | 'failed';

function Unlock() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<State>('working');

  useEffect(() => {
    if (!token) {
      setState('failed');
      return;
    }

    void (async () => {
      try {
        const response = await fetch('/api/auth/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          credentials: 'same-origin',
        });
        setState(response.ok ? 'done' : 'failed');
      } catch {
        setState('failed');
      }
    })();
  }, [token]);

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <Panel>
        <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
          <span className="cursor">core unlock</span>
        </h1>

        {state === 'working' ? (
          <p className="text-muted mt-6 font-mono text-sm" data-testid="unlock-working">
            <span aria-hidden="true">&gt; </span>
            checking the link…
          </p>
        ) : state === 'done' ? (
          <>
            <p className="text-accent mt-6 font-mono text-sm" data-testid="unlock-done">
              <span aria-hidden="true">&gt; </span>
              The lock is lifted. You can sign in again now.
            </p>
            <p className="text-muted mt-4 font-mono text-xs leading-relaxed">
              <span aria-hidden="true">&gt; </span>
              This did not sign you in and it did not open your vault — that still needs your master
              password, and nobody here can do it for you.
            </p>
          </>
        ) : (
          <>
            <p className="text-danger mt-6 font-mono text-sm" data-testid="unlock-failed">
              <span aria-hidden="true">! </span>
              That link did not work.
            </p>
            <p className="text-muted mt-4 font-mono text-xs leading-relaxed">
              <span aria-hidden="true">&gt; </span>
              Links work once and expire after fifteen minutes. If this one was already used, or is
              older than that, the lock will have expired by itself anyway — sign in as usual.
              Nobody is ever locked out for good.
            </p>
          </>
        )}

        <Link
          href="/login"
          className="text-accent hover:bg-accent hover:text-bg mt-8 inline-block font-mono text-sm"
          data-testid="unlock-to-login"
        >
          &gt; go to sign in
        </Link>
      </Panel>
    </main>
  );
}

export default function UnlockPage() {
  return (
    <Suspense
      fallback={
        <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6">
          <Panel>
            <p className="text-muted font-mono text-sm">
              <span aria-hidden="true">&gt; </span>
              loading…
            </p>
          </Panel>
        </main>
      }
    >
      <Unlock />
    </Suspense>
  );
}
