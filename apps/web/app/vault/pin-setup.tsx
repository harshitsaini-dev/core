'use client';

import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, isValidPin } from '@core/crypto';
import { Button, Field, Input, Panel, Warning } from '@core/ui';
import { useEffect, useId, useState } from 'react';
import {
  PasskeyUnsupported,
  disablePasskey,
  enablePasskey,
  passkeyStatus,
  passkeysPossible,
} from '@/lib/client/passkey';
import { PIN_ATTEMPT_LIMIT, disablePin, enablePin, pinStatus } from '@/lib/client/pin';
import { toast } from '@/lib/client/toast-store';

/**
 * Setting up quick unlock.
 *
 * Written as a disclosure, like the landing page and for the same reason. This
 * screen is where somebody agrees to let four digits open their vault on this
 * device, and a form that presented that as a convenience feature without
 * saying what it costs would be getting consent for something it had not
 * described.
 *
 * The master password is asked for here. That is not a confirmation step bolted
 * on for feel — the Account Key is only ever held as a non-extractable key, so
 * re-wrapping it under the PIN genuinely requires deriving the Master Key
 * again. The security property is a consequence of the cryptography rather than
 * a policy the UI is enforcing.
 */
export function PinSetupPanel({ onBack }: { readonly onBack: () => void }) {
  const emailId = useId();
  const passwordId = useId();
  const pinId = useId();
  const confirmId = useId();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void pinStatus().then((status) => setEnabled(status.enabled));
  }, []);

  const mismatch = confirm !== '' && pin !== confirm;
  const ready = email !== '' && password !== '' && isValidPin(pin) && pin === confirm;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || busy) return;

    setBusy(true);
    setError('');

    try {
      await enablePin(email, password, pin);
      setEnabled(true);
      setPassword('');
      setPin('');
      setConfirm('');
      toast('Quick unlock is on for this device.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not set the PIN.');
    } finally {
      setBusy(false);
    }
  }

  async function turnOff(): Promise<void> {
    await disablePin();
    setEnabled(false);
    toast('Quick unlock is off. This device needs the master password again.');
  }

  return (
    <Panel className="mt-6" data-testid="pin-setup">
      <h2 className="text-accent typewriter mb-2 font-mono text-sm tracking-widest uppercase">
        quick unlock
      </h2>
      <p className="text-muted mb-6 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        Open this vault on this device with a PIN instead of the master password.
      </p>

      <Warning title="what this costs">
        A PIN is short enough to guess and short enough to watch somebody type. Turning this on
        means anyone who has this device and those digits has the vault — the master password stops
        being the thing standing in the way here. It is stored on this device only, and it never
        leaves it.
      </Warning>

      <p className="text-muted mt-4 font-mono text-xs leading-relaxed">
        <span aria-hidden="true">&gt; </span>
        {PIN_ATTEMPT_LIMIT} wrong PINs and it is deleted, not suspended. The vault still opens with
        the master password, which is the part that has any real strength to it.
      </p>

      {enabled === true ? (
        <div className="border-line mt-8 border-t pt-6">
          <p className="text-accent font-mono text-sm" data-testid="pin-enabled">
            <span aria-hidden="true">&gt; </span>
            Quick unlock is on for this device.
          </p>
          <Button
            type="button"
            variant="danger"
            onClick={() => void turnOff()}
            className="mt-4"
            data-testid="pin-disable"
          >
            turn it off
          </Button>
        </div>
      ) : enabled === false ? (
        <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-4" noValidate>
          <Field label="email" htmlFor={emailId}>
            <Input
              id={emailId}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              data-testid="pin-email"
            />
          </Field>

          <Field label="master password" htmlFor={passwordId}>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              data-testid="pin-password"
            />
          </Field>

          <Field label={`pin (${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH} digits)`} htmlFor={pinId}>
            <Input
              id={pinId}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={MAX_PIN_LENGTH}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              disabled={busy}
              data-testid="pin-new"
            />
          </Field>

          <Field label="confirm pin" htmlFor={confirmId}>
            <Input
              id={confirmId}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={MAX_PIN_LENGTH}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value.replace(/\D/g, ''))}
              disabled={busy}
              data-testid="pin-confirm"
            />
          </Field>

          {mismatch ? (
            <p className="text-danger font-mono text-xs" data-testid="pin-mismatch">
              <span aria-hidden="true">! </span>
              Those two do not match.
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-danger font-mono text-xs" data-testid="pin-setup-error">
              <span aria-hidden="true">! </span>
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={!ready || busy} data-testid="pin-save">
            {busy ? '... setting' : 'turn on quick unlock'}
          </Button>
        </form>
      ) : null}

      <Passkeys />

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-8"
        data-testid="pin-back"
      >
        back
      </Button>
    </Panel>
  );
}

/**
 * Unlocking with a fingerprint.
 *
 * Alongside the PIN because they answer the same question — open this vault on
 * this device without typing the master password — and differ in what they cost.
 * A PIN is six digits and needs an attempt limit. A passkey is a secret held in
 * hardware that cannot be guessed, so it needs none, and it is the better
 * choice wherever the browser can derive a key from one.
 *
 * Offered only where that derivation is possible. A passkey that can sign but
 * not derive would mean checking a signature in the page and then handing over
 * the vault key — an `if` statement in front of a secret, which is not a
 * security feature no matter how it is labelled.
 */
function Passkeys() {
  const emailId = useId();
  const passwordId = useId();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void passkeyStatus().then((status) => setEnabled(status.enabled));
  }, []);

  if (!passkeysPossible()) return null;

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || email === '' || password === '') return;

    setBusy(true);
    setError('');
    try {
      await enablePasskey(email, password);
      setEnabled(true);
      setPassword('');
      toast('This device can now unlock with a passkey.');
    } catch (cause) {
      setError(
        cause instanceof PasskeyUnsupported || cause instanceof Error
          ? cause.message
          : 'Could not add a passkey.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-line mt-8 border-t pt-6" data-testid="passkey-section">
      <h3 className="text-accent-dim mb-2 font-mono text-xs tracking-widest uppercase">
        or a passkey
      </h3>
      <p className="text-muted mb-4 font-mono text-xs leading-relaxed">
        <span aria-hidden="true">&gt; </span>A fingerprint or face, instead of digits. The key comes
        from the authenticator itself and never reaches this page or the server — which is what
        makes it possible here at all, and why it is offered only where the hardware can do it.
      </p>

      {enabled === true ? (
        <>
          <p className="text-accent font-mono text-sm" data-testid="passkey-enabled">
            <span aria-hidden="true">&gt; </span>A passkey can open this vault on this device.
          </p>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              void disablePasskey().then(() => {
                setEnabled(false);
                toast('Passkey unlock is off for this device.');
              });
            }}
            className="mt-4"
            data-testid="passkey-disable"
          >
            turn it off
          </Button>
        </>
      ) : enabled === false ? (
        <form onSubmit={(event) => void add(event)} className="space-y-4" noValidate>
          <Field label="email" htmlFor={emailId}>
            <Input
              id={emailId}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              data-testid="passkey-email"
            />
          </Field>
          <Field label="master password" htmlFor={passwordId}>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              data-testid="passkey-password"
            />
          </Field>

          {error ? (
            <p role="alert" className="text-danger font-mono text-xs" data-testid="passkey-error">
              <span aria-hidden="true">! </span>
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={busy || !email || !password} data-testid="passkey-add">
            {busy ? '... asking the device' : 'add a passkey'}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
