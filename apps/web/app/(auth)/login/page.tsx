'use client';

import type { AccountKeys } from '@core/crypto';
import { Button, Field, Input, Panel } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import { LoginFailed, login, unlockOffline } from '@/lib/client/auth';
import { useVault } from '@/lib/client/vault-store';
import { passkeyStatus } from '@/lib/client/passkey';
import { pinStatus } from '@/lib/client/pin';
import { PinUnlock } from './pin-unlock';

/**
 * Unlock.
 *
 * Two round trips happen behind one button: prelogin fetches the salt and KDF
 * parameters, then the derived Auth Key is exchanged for a session and the
 * wrapped Account Key, which is unwrapped here in the browser.
 *
 * The progress line is not decoration. Key derivation is calibrated to cost
 * roughly half a second and can take noticeably longer on a phone; a button
 * that simply sits there reads as broken rather than as careful, and the one
 * thing this screen cannot afford is for someone to conclude it is broken and
 * go looking for a "reset password" link that does not exist.
 */
export default function LoginPage() {
  const emailId = useId();
  const passwordId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  // `null` until the lookup finishes, and null forever on a device with no PIN.
  // Rendering the password form first and replacing it a moment later would
  // move the field under a cursor that is already typing.
  const [pinEmail, setPinEmail] = useState<string | null>(null);
  const [pinDismissed, setPinDismissed] = useState(false);

  useEffect(() => {
    void Promise.all([pinStatus(), passkeyStatus()]).then(([pin, passkey]) => {
      // Either one puts the quick-unlock screen up. They share it: the passkey
      // is a button at the top and the PIN pad is below, and neither is the
      // only way in.
      setPinEmail(pin.enabled ? pin.email : passkey.enabled ? passkey.email : null);
    });
  }, []);

  const router = useRouter();
  const unlock = useVault((state) => state.unlock);

  /**
   * Into the vault, however the keys were obtained.
   *
   * Client-side navigation, deliberately. The keys live in memory and are never
   * persisted, so a full page load would discard them and land on a locked
   * vault a moment after unlocking it.
   */
  const enter = useCallback(
    (keys: AccountKeys) => {
      unlock(keys);
      router.push('/vault');
    },
    [router, unlock],
  );

  const onSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy || email === '' || password === '') return;

      setError('');
      setBusy(true);

      try {
        let keys;
        try {
          keys = await login(email, password, setProgress);
        } catch (networkFailure) {
          // A rejected password is final; only an unreachable server is worth
          // falling back for. Trying the local copy after a genuine rejection
          // would let an old password keep working after it was changed
          // elsewhere.
          if (networkFailure instanceof LoginFailed) throw networkFailure;
          setProgress('offline — unlocking from this device');
          keys = await unlockOffline(email, password, setProgress);
        }

        enter(keys);
      } catch (cause) {
        // One message for a wrong password, an unknown address and a failed
        // unwrap alike. The API refuses to distinguish those, and a UI that
        // helpfully guessed would hand back the enumeration oracle the server
        // was built to withhold.
        setError(
          cause instanceof LoginFailed
            ? 'Those credentials did not work.'
            : 'Could not reach the vault. Check your connection and try again.',
        );
        setBusy(false);
        setProgress('');
      }
    },
    [busy, email, enter, password],
  );

  // Rendered instead of the password form, never above it: two credential
  // fields on one screen is an invitation to type the wrong secret into the
  // wrong box. The way back is a button, not a scroll.
  if (pinEmail !== null && !pinDismissed) {
    return (
      <main
        id="main"
        className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16"
      >
        <PinUnlock
          email={pinEmail}
          onUnlocked={enter}
          onUsePassword={() => setPinDismissed(true)}
        />
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <Panel>
        <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
          <span className="cursor">core unlock</span>
        </h1>
        <p className="text-muted mt-2 text-sm">
          Your master password is derived here, in this browser. It is never sent.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-6" noValidate>
          <Field label="email" htmlFor={emailId}>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              required
            />
          </Field>

          <Field label="master password" htmlFor={passwordId}>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
          </Field>

          {error ? (
            <p role="alert" className="text-danger font-mono text-xs" data-testid="login-error">
              <span aria-hidden="true">! </span>
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={busy || email === '' || password === ''}
            className="w-full"
            data-testid="unlock"
          >
            {busy ? `... ${progress}` : 'unlock'}
          </Button>

          {busy ? (
            <p className="text-muted font-mono text-xs" aria-live="polite" data-testid="progress">
              <span aria-hidden="true">&gt; </span>
              {progress}
            </p>
          ) : null}
        </form>
      </Panel>

      <p className="text-muted mt-6 font-mono text-xs">
        No vault yet?{' '}
        <a className="text-accent hover:bg-accent hover:text-bg" href="/signup">
          create one
        </a>
        {' · '}
        <a className="text-accent hover:bg-accent hover:text-bg" href="/recover">
          lost your password?
        </a>
      </p>
    </main>
  );
}
