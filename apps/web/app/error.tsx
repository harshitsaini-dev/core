'use client';

import { Button, StatusScreen, buttonClasses } from '@core/ui';
import Link from 'next/link';
import { useEffect } from 'react';

/**
 * An unexpected failure inside the app.
 *
 * Deliberately vague about the cause. The error object can carry a stack, a
 * query fragment, or a message that names a table — none of which a visitor
 * needs and any of which is worth more to somebody probing than to the person
 * it interrupted.
 *
 * The reassurance about the vault is not filler. This screen appears at the
 * worst possible moment for a password manager, and the first question a user
 * asks is whether their data survived. It did: the server never held anything
 * readable to lose.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side only. Nothing about this reaches the page.
    console.error('unhandled application error', error.digest ?? error.message);
  }, [error]);

  return (
    <StatusScreen
      code="500"
      title="something broke"
      actions={
        <>
          <Button type="button" onClick={reset}>
            try again
          </Button>
          <Link href="/" className={buttonClasses('ghost')}>
            back to start
          </Link>
        </>
      }
    >
      <p>
        <span aria-hidden="true">&gt; </span>
        An unexpected error interrupted that request.
      </p>
      <p>
        <span aria-hidden="true">&gt; </span>
        Your vault is untouched. Nothing readable is stored server-side, so there is nothing here
        that a failure could have corrupted or exposed.
      </p>
      {error.digest ? (
        <p className="text-muted/70 text-xs">
          <span aria-hidden="true">&gt; </span>
          reference {error.digest}
        </p>
      ) : null}
    </StatusScreen>
  );
}
