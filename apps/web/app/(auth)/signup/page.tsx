'use client';

import { Button, Field, Input, Panel, Warning } from '@core/ui';
import { TurnstileGate } from '../turnstile-gate';
import { useCallback, useEffect, useId, useState } from 'react';
import { signup, startSignup } from '@/lib/client/auth';
import { MINIMUM_SCORE, estimate } from '@/lib/client/strength';
import type { Strength } from '@/lib/client/strength';
import { EmergencyKit } from './emergency-kit';

/**
 * Signup.
 *
 * The form is the last point at which a user can be stopped from creating a
 * vault they cannot protect, so it does two things most signup forms do not:
 *
 *   1. It refuses a weak master password rather than warning about it. There is
 *      no password reset here — a weak one is not a risk the user can revisit
 *      later, it is a permanent property of their vault.
 *
 *   2. It shows the Emergency Kit before declaring success, and requires an
 *      explicit acknowledgement. Losing the kit and the password means losing
 *      everything, and a dismissible toast is not consent.
 */

/**
 * `code` sits between the form and the work.
 *
 * The address is proved before the account is written, so a vault cannot be
 * created on somebody else's inbox. The password fields stay filled underneath
 * — asking for them again after a detour to a mail client is how people end up
 * typing a different master password from the one they meant, in the one place
 * where that cannot be undone.
 */
type Stage = 'form' | 'sending' | 'code' | 'working' | 'kit';

export default function SignupPage() {
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [strength, setStrength] = useState<Strength | null>(null);
  const [stage, setStage] = useState<Stage>('form');
  const [code, setCode] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  // Held here rather than read from the DOM at submit time: a token is
  // single-use, so the form has to know when it no longer holds a good one.
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);

  useEffect(() => {
    if (password === '') {
      setStrength(null);
      return;
    }

    // Debounced: the estimator walks large dictionaries, and running it on every
    // keystroke makes typing feel laggy on a phone.
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
  const canSubmit =
    email.includes('@') &&
    password.length > 0 &&
    confirm === password &&
    strength !== null &&
    !tooWeak &&
    stage === 'form';

  const onSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;

      setError('');
      setStage('sending');

      try {
        // The address first. Nothing is derived and nothing is created until
        // somebody has read the code, so an address that is not yours costs an
        // email and produces no account.
        const needsCode = await startSignup(email, botToken ?? undefined);

        if (needsCode) {
          setStage('code');
          return;
        }

        setStage('working');
        const result = await signup(email, password, setProgress, botToken ?? undefined);
        setRecoveryKey(result.recoveryKey);
        setStage('kit');
      } catch {
        // Deliberately vague. The server answers identically whether or not the
        // address was already registered, and the UI must not invent a
        // distinction the API refuses to make.
        setError('Could not create the account. Check your connection and try again.');
        setStage('form');
      } finally {
        setProgress('');
        // A used token is spent whether or not the signup worked, so the next
        // attempt needs a fresh one.
        setBotToken(null);
        setBotReset((n) => n + 1);
      }
    },
    [botToken, canSubmit, email, password],
  );

  const onVerify = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (code.trim().length !== 6) return;

    setError('');
    setStage('working');

    try {
      const result = await signup(email, password, setProgress, undefined, code.trim());
      setRecoveryKey(result.recoveryKey);
      setStage('kit');
    } catch {
      // The server gives one answer to a wrong code, an expired one, and an
      // address that already has an account. Inventing a distinction here would
      // hand back the enumeration oracle the API refuses to be.
      setError('That code did not work. Ask for another and try again.');
      setStage('code');
    } finally {
      setProgress('');
    }
  };

  if (stage === 'kit') {
    return <EmergencyKit email={email} recoveryKey={recoveryKey} />;
  }

  if (stage === 'code') {
    return (
      <main
        id="main"
        className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16"
      >
        <Panel>
          <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
            <span className="cursor">core --verify-address</span>
          </h1>
          <p className="text-muted mt-2 text-sm">
            A six-digit code is on its way to <span className="text-fg">{email}</span>. Nothing has
            been created yet — the account is written once the address is proved.
          </p>

          <form onSubmit={(event) => void onVerify(event)} className="mt-8 space-y-6" noValidate>
            <Field label="the code from your email" htmlFor="signup-code">
              <Input
                id="signup-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                data-testid="signup-code"
              />
            </Field>

            <Button
              type="submit"
              disabled={code.trim().length !== 6}
              className="w-full"
              data-testid="signup-verify"
            >
              verify and create the vault
            </Button>

            {error !== '' ? (
              <p role="alert" className="text-danger font-mono text-xs" data-testid="signup-error">
                <span aria-hidden="true">! </span>
                {error}
              </p>
            ) : null}

            <p className="text-muted font-mono text-xs leading-relaxed">
              <span aria-hidden="true">&gt; </span>
              No code? Check the spam folder. If this address already has a vault, the mail says so
              instead and there is no code to enter — sign in rather than signing up.
            </p>
          </form>
        </Panel>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <Panel>
        <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
          <span className="cursor">core --create-vault</span>
        </h1>
        <p className="text-muted mt-2 text-sm">
          Your master password is the only thing that can open this vault. Not us.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-6" noValidate>
          <Field label="email" htmlFor={emailId} hint="Used for security alerts and recovery.">
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={stage === 'working'}
              required
            />
          </Field>

          <Field
            label="master password"
            htmlFor={passwordId}
            error={
              tooWeak ? strength?.warning || 'Too weak. Make it longer, not cleverer.' : undefined
            }
            hint={strength ? undefined : 'A long passphrase beats a short complicated one.'}
          >
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={stage === 'working'}
              invalid={tooWeak}
              required
            />
            <StrengthMeter strength={strength} />
          </Field>

          <Field
            label="confirm master password"
            htmlFor={confirmId}
            error={mismatch ? 'The two passwords do not match.' : undefined}
          >
            <Input
              id={confirmId}
              name="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={stage === 'working'}
              invalid={mismatch}
              required
            />
          </Field>

          <Warning title="no password reset">
            Lose your master password and your Emergency Kit, and the vault is gone for good. Nobody
            can recover it — us included.
          </Warning>

          {error ? (
            <p role="alert" className="text-danger font-mono text-xs">
              <span aria-hidden="true">! </span>
              {error}
            </p>
          ) : null}

          <TurnstileGate onToken={setBotToken} resetSignal={botReset} />

          <Button type="submit" disabled={!canSubmit} className="w-full">
            {stage === 'working' || stage === 'sending'
              ? `... ${progress || 'checking the address'}`
              : 'create vault'}
          </Button>

          {stage === 'working' ? (
            <p className="text-muted font-mono text-xs" aria-live="polite">
              <span aria-hidden="true">&gt; </span>
              Key derivation is deliberately slow. This is the same work an attacker would have to
              repeat for every guess.
            </p>
          ) : null}
        </form>
      </Panel>

      <p className="text-muted mt-6 font-mono text-xs">
        Already have a vault?{' '}
        <a className="text-accent hover:bg-accent hover:text-bg" href="/login">
          unlock it
        </a>
      </p>
    </main>
  );
}

/**
 * Five blocks, filled to the score, with the score written out beneath.
 *
 * Colour alone would not carry this — the palette is a single hue and a
 * meaningful fraction of readers cannot rely on it — so the filled-block count
 * and the written label do the work and the colour merely reinforces.
 *
 * The label stays visible even when the password is rejected. Telling somebody
 * "too weak" without telling them how weak, or what strong enough looks like,
 * leaves them guessing at the one decision they cannot revisit later.
 */
function StrengthMeter({ strength }: { strength: Strength | null }) {
  const score = strength?.score ?? -1;

  return (
    <div className="pt-1">
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index}
            data-testid={`strength-block-${index}`}
            data-filled={index <= score}
            className={
              index <= score
                ? score < MINIMUM_SCORE
                  ? 'h-1 flex-1 bg-danger'
                  : 'h-1 flex-1 bg-accent'
                : 'h-1 flex-1 bg-line'
            }
          />
        ))}
      </div>

      {strength ? (
        <p
          className="text-muted pt-2 font-mono text-xs"
          data-testid="strength-summary"
          aria-live="polite"
        >
          <span className={score < MINIMUM_SCORE ? 'text-danger' : 'text-accent'}>
            {strength.label}
          </span>
          {' — an offline attacker would need '}
          {strength.crackTime}
        </p>
      ) : null}
    </div>
  );
}
