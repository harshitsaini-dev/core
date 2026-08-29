'use client';

import type { AccountKeys } from '@core/crypto';
import { Button, Field, Input, Panel } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { turnstileEnabled, waitForToken } from '@/lib/client/turnstile';
import {
  BotCheckFailed,
  DeviceVerificationRequired,
  LoginFailed,
  RateLimited,
  login,
  unlockOffline,
  verifyDevice,
} from '@/lib/client/auth';
import { useVault } from '@/lib/client/vault-store';
import { passkeyStatus } from '@/lib/client/passkey';
import { pinStatus } from '@/lib/client/pin';
import { TurnstileGate } from '../turnstile-gate';
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
  const codeId = useId();

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
  // Held here rather than read from the DOM at submit time: a token is
  // single-use, so the form has to know when it no longer holds a good one.
  const [botReset, setBotReset] = useState(0);
  // Read through a ref as well as state: the submit handler is created before
  // the token arrives, and a closure over the state value would still be null
  // when it does.
  const botTokenRef = useRef<string | null>(null);
  const [unlockSent, setUnlockSent] = useState(false);
  // Set when the password was right and this browser is not recognised. The
  // password is kept because the code releases a session and the password is
  // still what opens the vault — see `verifyDevice`.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');

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
        /*
         * Give the bot check the moment it needs.
         *
         * The widget is hidden until it has something to ask, so there is
         * nothing on screen saying a check is running — and somebody pressing
         * the button a second after the page loads used to submit without a
         * token and be told to complete a check they could not see.
         *
         * Bounded, because a blocked script means no token is ever coming and
         * the server fails open for that case. Waiting past that would make a
         * check designed to get out of the way into the thing in the way.
         */
        let token = botTokenRef.current;
        if (!token && turnstileEnabled()) {
          setProgress('checking you are human');
          token = await waitForToken(() => botTokenRef.current);
        }

        let keys;
        try {
          keys = await login(email, password, setProgress, token ?? undefined);
        } catch (failure) {
          /*
           * Only an unreachable server is worth falling back for.
           *
           * This used to rethrow `LoginFailed` and treat everything else as a
           * network problem, which was right until there were other things it
           * could be. A new browser gets `DeviceVerificationRequired` — the
           * password was accepted and a code is on its way — and that fell into
           * the offline path, where a device with nothing stored answered
           * `LoginFailed`, and the screen said the credentials were wrong. The
           * code had already been sent; there was just nowhere to type it.
           *
           * Listed as what may fall through rather than what may not, so the
           * next error added to this path does not quietly inherit the wrong
           * branch.
           */
          const answered =
            failure instanceof LoginFailed ||
            failure instanceof DeviceVerificationRequired ||
            failure instanceof RateLimited ||
            failure instanceof BotCheckFailed;

          if (answered) throw failure;

          setProgress('offline — unlocking from this device');
          keys = await unlockOffline(email, password, setProgress);
        }

        enter(keys);
      } catch (cause) {
        if (cause instanceof DeviceVerificationRequired) {
          // Not a failure. The password was right; the browser is new.
          setNeedsCode(true);
          setError('');
          setBusy(false);
          setProgress('');
          botTokenRef.current = null;
          setBotReset((n) => n + 1);
          return;
        }

        /*
         * Four outcomes, and only one of them is "your password is wrong".
         *
         * A wrong password, an unknown address and a failed unwrap share a
         * message, because the API refuses to distinguish them and a UI that
         * helpfully guessed would hand back the enumeration oracle the server
         * was built to withhold.
         *
         * The other two are not about the account at all. A rate limit and an
         * unfinished bot check describe this request, so saying which one
         * happened leaks nothing — and calling either of them "wrong
         * credentials" tells somebody the one thing that is definitely untrue,
         * which this screen did until today, twice.
         */
        setError(
          cause instanceof BotCheckFailed
            ? cause.message
            : cause instanceof RateLimited
              ? `Too many attempts from here. Try again in about ${Math.ceil(
                  cause.retryAfterSeconds / 60,
                )} minute${cause.retryAfterSeconds > 90 ? 's' : ''}.`
              : cause instanceof LoginFailed
                ? 'Those credentials did not work.'
                : 'Could not reach the vault. Check your connection and try again.',
        );
        setBusy(false);
        setProgress('');
        // A used token is spent, whether or not the sign-in worked. Without
        // this the next attempt sends the same one and fails verification in a
        // way that reads as the password being wrong.
        botTokenRef.current = null;
        setBotReset((n) => n + 1);
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

  /*
   * The password was right and this browser is new.
   *
   * Shown instead of the password form rather than beside it. The password has
   * already been accepted; asking for it again next to a code would suggest one
   * of them failed.
   */
  if (needsCode) {
    return (
      <main
        id="main"
        className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16"
      >
        <Panel>
          <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
            <span className="cursor">core verify</span>
          </h1>
          <p className="text-muted mt-4 font-mono text-xs leading-relaxed">
            <span aria-hidden="true">&gt; </span>
            Your password was right, and this browser has not signed in to this account before. A
            six-digit code is on its way to your email.
          </p>
          <p className="text-muted mt-2 font-mono text-xs leading-relaxed">
            <span aria-hidden="true">&gt; </span>
            The code does not open your vault — your master password already did that, here in this
            browser. It only lets this device through.
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || code.length !== 6) return;

              setBusy(true);
              setError('');

              void verifyDevice(email, password, code, setProgress)
                .then(enter)
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof RateLimited
                      ? cause.message
                      : 'That code did not work. After three tries it stops working — sign in again for a new one.',
                  );
                  setCode('');
                  setBusy(false);
                  setProgress('');
                });
            }}
            className="mt-8 space-y-6"
            noValidate
          >
            <Field label="six-digit code" htmlFor={codeId}>
              <Input
                id={codeId}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                disabled={busy}
                data-testid="device-code"
              />
            </Field>

            {error ? (
              <p role="alert" className="text-danger font-mono text-xs" data-testid="device-error">
                <span aria-hidden="true">! </span>
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full"
              data-testid="verify-device"
            >
              {busy ? `... ${progress}` : 'verify this device'}
            </Button>
          </form>

          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setNeedsCode(false);
              setCode('');
              setError('');
            }}
            className="mt-6"
            data-testid="device-back"
          >
            back
          </Button>
        </Panel>
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
            <>
              <p role="alert" className="text-danger font-mono text-xs" data-testid="login-error">
                <span aria-hidden="true">! </span>
                {error}
              </p>

              {/*
                Offered after any failure rather than only after a lockout,
                because the client is not told which one happened — the server
                answers identically for a wrong password, an unknown address
                and a locked account, and a UI that knew the difference would
                be handing back the oracle the API refuses to give.

                The endpoint sends nothing unless the account exists and is
                actually locked, so offering it here costs nothing.
              */}
              {unlockSent ? (
                <div data-testid="unlock-sent">
                  <p className="text-muted font-mono text-xs leading-relaxed">
                    <span aria-hidden="true">&gt; </span>
                    If that address has an account and it is locked, a link is on its way. It lifts
                    the lock only — you will still need your master password.
                  </p>
                  {/*
                    The reassurance that actually matters, and the first version
                    of this screen left it out: a lockout is not a state anybody
                    can be stranded in. It clears itself, so a mail that never
                    arrives costs a wait rather than an account.
                  */}
                  <p className="text-muted mt-2 font-mono text-xs leading-relaxed">
                    <span aria-hidden="true">&gt; </span>
                    If it does not arrive, check spam — and either way the lock expires on its own
                    within fifteen minutes. Nobody is ever locked out for good.
                  </p>
                  <button
                    type="button"
                    onClick={() => setUnlockSent(false)}
                    className="text-accent-dim hover:text-accent mt-2 font-mono text-xs"
                    data-testid="request-unlock-again"
                  >
                    &gt; send it again
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setUnlockSent(true);
                    void fetch('/api/auth/unlock-request', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ email }),
                      credentials: 'same-origin',
                    });
                  }}
                  disabled={email === ''}
                  className="text-accent-dim hover:text-accent font-mono text-xs disabled:opacity-40"
                  data-testid="request-unlock"
                >
                  &gt; locked out? email me a link
                </button>
              )}
            </>
          ) : null}

          <TurnstileGate
            onToken={(token) => {
              // A ref, not state. Nothing on screen depends on whether a token
              // is held — the widget draws itself — and the submit handler
              // needs the current value rather than the one its closure saw.
              botTokenRef.current = token;
            }}
            resetSignal={botReset}
          />

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
