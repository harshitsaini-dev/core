'use client';

import { useEffect, useRef, useState } from 'react';
import { mountTurnstile, turnstileEnabled } from '@/lib/client/turnstile';

/**
 * The bot check on a sign-in or sign-up form.
 *
 * Renders nothing at all where no site key is configured, which is the case for
 * every self-hosted instance that did not set one up. Not a disabled widget or
 * a placeholder — nothing, and no third-party script fetched either.
 *
 * The token is handed back through `onToken` rather than read out of the DOM by
 * the form, because a token is single-use: after a submission the widget has to
 * be reset and the form has to know it no longer holds a valid one, or the next
 * attempt fails verification in a way that reads as the password being wrong.
 */
export function TurnstileGate({
  onToken,
  resetSignal,
}: {
  readonly onToken: (token: string | null) => void;
  /** Changing this resets the widget — bump it after a failed submission. */
  readonly resetSignal: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const reset = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!turnstileEnabled() || !host.current) return undefined;

    let live = true;
    let teardown: (() => void) | null = null;

    void mountTurnstile(host.current, onToken)
      .then((fn) => {
        if (!live) {
          fn();
          return;
        }
        teardown = fn;
        reset.current = fn;
      })
      .catch(() => {
        // The script did not load — an ad blocker, a filtered network, an
        // outage. Said out loud rather than left as a form that will not
        // submit for no visible reason. The server fails open on its side, so
        // this is honest about what happens next.
        if (live) setFailed(true);
      });

    return () => {
      live = false;
      teardown?.();
      reset.current = null;
    };
  }, [onToken]);

  useEffect(() => {
    if (resetSignal > 0) reset.current?.();
  }, [resetSignal]);

  if (!turnstileEnabled()) return null;

  return (
    <div data-testid="turnstile-gate">
      <div ref={host} />
      {failed ? (
        <p className="text-muted mt-2 font-mono text-xs" data-testid="turnstile-unavailable">
          <span aria-hidden="true">&gt; </span>
          The bot check did not load. You can still sign in.
        </p>
      ) : null}
    </div>
  );
}
