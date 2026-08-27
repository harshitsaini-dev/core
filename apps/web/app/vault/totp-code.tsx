'use client';

import { secondsRemaining, totp } from '@core/crypto';
import type { TotpOptions } from '@core/crypto';
import { useEffect, useState } from 'react';
import { copySecret, pulse } from '@/lib/client/clipboard';

/**
 * A live TOTP code with its countdown.
 *
 * The countdown is not decoration. A code with four seconds left will be
 * rejected by the time it is pasted, and without something showing that, the
 * failure looks like a wrong secret rather than bad timing — which sends people
 * off to re-scan a QR code that was fine.
 */
export function TotpCode({ secret, options }: { secret: string; options?: TotpOptions }) {
  const [code, setCode] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(30);
  const [invalid, setInvalid] = useState(false);
  const [copied, setCopied] = useState(false);

  const period = options?.period ?? 30;

  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const next = await totp(secret, Date.now(), options);
        if (!cancelled) {
          setCode(next);
          setInvalid(false);
        }
      } catch {
        // A secret that will not decode is a stored value that is wrong, not a
        // transient failure. Say so rather than showing a stale code.
        if (!cancelled) setInvalid(true);
      }

      if (!cancelled) setRemaining(secondsRemaining(Date.now(), period));
    };

    void tick();
    // Every second rather than every period: the countdown has to move, and
    // recomputing a HMAC once a second costs nothing.
    const timer = setInterval(() => void tick(), 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [secret, options, period]);

  if (invalid) {
    return (
      <p role="alert" className="text-danger font-mono text-xs" data-testid="totp-invalid">
        <span aria-hidden="true">! </span>
        This one-time-code secret could not be read.
      </p>
    );
  }

  async function copy(): Promise<void> {
    if (!code) return;
    // A shorter clear than a password: the code is worthless in thirty seconds
    // anyway, so leaving it on the clipboard buys nothing.
    if (await copySecret(code, period * 1000)) {
      pulse();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => void copy()}
        className="text-accent hover:bg-accent hover:text-bg min-h-11 border border-accent px-3 font-mono text-lg tracking-[0.3em]"
        data-testid="totp-code"
        aria-label={copied ? 'copied' : 'copy one-time code'}
      >
        {code ?? '······'}
      </button>

      <span
        className={
          remaining <= 5 ? 'text-warning font-mono text-xs' : 'text-muted font-mono text-xs'
        }
        data-testid="totp-remaining"
        aria-live="off"
      >
        {remaining}s
        {/* Announced separately and only near expiry, so a screen reader is not
            read a number every second. */}
        <span className="sr-only" aria-live="polite">
          {remaining <= 5 ? `code expires in ${remaining} seconds` : ''}
        </span>
      </span>
    </div>
  );
}
