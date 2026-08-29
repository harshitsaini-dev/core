'use client';

import { Button, Field, Input, Panel, Warning } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import { RecoveryFailed, recover } from '@/lib/client/auth';
import { MINIMUM_SCORE, estimate } from '@/lib/client/strength';
import type { Strength } from '@/lib/client/strength';
import { useVault } from '@/lib/client/vault-store';

/**
 * Recovery from the Emergency Kit.
 *
 * This is the only way back into a vault whose master password is gone, and it
 * is the reason the kit is worth printing. Two things worth knowing about what
 * happens here:
 *
 *   - The vault is not re-encrypted. The recovery key *is* the Account Key, so
 *     this unwraps 32 bytes and re-wraps the same 32 bytes under a key derived
 *     from the new password. Ten thousand items cost the same as none.
 *
 *   - The server cannot do this on anybody else's behalf. It never receives the
 *     recovery key, only a verifier derived from it, which proves possession
 *     and decrypts nothing.
 */
export default function RecoverPage() {
  const emailId = useId();
  const keyId = useId();
  const passwordId = useId();
  const confirmId = useId();

  const [email, setEmail] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [strength, setStrength] = useState<Strength | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const router = useRouter();
  const unlock = useVault((state) => state.unlock);

  useEffect(() => {
    if (password === '') {
      setStrength(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void estimate(password, [email, 'core', 'vault']).then((result) => {
        if (!cancelled) setStrength(result);
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [password, email]);

  const tooWeak = strength !== null && strength.score < MINIMUM_SCORE;
  const mismatch = confirm !== '' && confirm !== password;

  // The same bar as signup. A vault recovered behind a weak password ends up in
  // exactly the position it would have been in had it been created that way.
  const canSubmit =
    !busy &&
    email.includes('@') &&
    recoveryKey.trim() !== '' &&
    password !== '' &&
    confirm === password &&
    strength !== null &&
    !tooWeak;

  const onSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;

      setError('');
      setBusy(true);

      try {
        const keys = await recover(email, recoveryKey.replace(/\s+/g, ''), password, setProgress);
        unlock(keys);
        // Client-side navigation, deliberately. The keys live in memory and are
        // never persisted, so a full page load would discard them and land on a
        // locked vault a moment after unlocking it. That is the cost of not
        // writing keys to disk, and it makes router.push a correctness
        // requirement here rather than a preference.
        router.push('/vault');
      } catch (cause) {
        setError(
          cause instanceof RecoveryFailed
            ? 'That recovery key does not match this account.'
            : 'Could not reach the server. Check your connection and try again.',
        );
        setBusy(false);
        setProgress('');
      }
    },
    [canSubmit, email, recoveryKey, password, router, unlock],
  );

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <Panel>
        <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
          <span className="cursor">core --recover</span>
        </h1>
        <p className="text-muted mt-2 text-sm">
          Use the recovery key from your Emergency Kit to set a new master password.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-6" noValidate>
          <Field label="email" htmlFor={emailId}>
            <Input
              id={emailId}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              required
            />
          </Field>

          <Field
            label="recovery key"
            htmlFor={keyId}
            hint="Spaces are ignored, so it can be typed exactly as printed."
          >
            <Input
              id={keyId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={recoveryKey}
              onChange={(event) => setRecoveryKey(event.target.value)}
              disabled={busy}
              required
            />
          </Field>

          <Field
            label="new master password"
            htmlFor={passwordId}
            error={
              tooWeak ? strength?.warning || 'Too weak. Make it longer, not cleverer.' : undefined
            }
            hint={
              strength ? `${strength.label} — ${strength.crackTime} to crack offline` : undefined
            }
          >
            <Input
              id={passwordId}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              invalid={tooWeak}
              required
            />
          </Field>

          <Field
            label="confirm new master password"
            htmlFor={confirmId}
            error={mismatch ? 'The two passwords do not match.' : undefined}
          >
            <Input
              id={confirmId}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={busy}
              invalid={mismatch}
              required
            />
          </Field>

          <Warning title="this signs out every device">
            Recovering ends all existing sessions. Your stored items are untouched — only the key
            that wraps them is re-wrapped.
          </Warning>

          {error ? (
            <p role="alert" className="text-danger font-mono text-xs" data-testid="recover-error">
              <span aria-hidden="true">! </span>
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={!canSubmit} className="w-full" data-testid="recover">
            {busy ? `... ${progress}` : 'recover vault'}
          </Button>
        </form>
      </Panel>

      <p className="text-muted mt-6 font-mono text-xs">
        Remembered it after all?{' '}
        <a className="text-accent hover:bg-accent hover:text-bg" href="/login">
          unlock instead
        </a>
      </p>
    </main>
  );
}
