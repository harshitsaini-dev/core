'use client';

import type { AccountKeys } from '@core/crypto';
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH } from '@core/crypto';
import { Button, Field, Input, Panel } from '@core/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { passkeyStatus, unlockWithPasskey } from '@/lib/client/passkey';
import { PinRejected, unlockWithPin } from '@/lib/client/pin';

/**
 * Quick unlock, when this device has been given a PIN.
 *
 * Shown only where it was set up, and never as the only way in: the master
 * password form is one click away and stays that way. A PIN is a convenience
 * bought on one device, and a screen that hid the real credential behind it
 * would be teaching people to forget the thing that actually opens the vault.
 */
export function PinUnlock({
  email,
  onUnlocked,
  onUsePassword,
}: {
  readonly email: string | null;
  readonly onUnlocked: (keys: AccountKeys) => void;
  readonly onUsePassword: () => void;
}) {
  const pinId = useId();

  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hasPasskey, setHasPasskey] = useState(false);

  useEffect(() => {
    void passkeyStatus().then((status) => setHasPasskey(status.enabled));
  }, []);

  /**
   * Unlock with the authenticator.
   *
   * Offered above the PIN pad where both exist, because it is the better of the
   * two: a secret in hardware rather than six digits, and nothing to watch
   * somebody type.
   */
  const usePasskey = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      onUnlocked(await unlockWithPasskey());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
      setBusy(false);
    }
  }, [onUnlocked]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy || pin.length < MIN_PIN_LENGTH) return;

      setBusy(true);
      setError('');

      try {
        onUnlocked(await unlockWithPin(pin));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That did not work.');
        setPin('');

        // The last wrong attempt destroys the stored material, so the form that
        // just failed is also gone. Falling through to the master password is
        // the only thing left, and doing it beats leaving a dead PIN pad up.
        if (cause instanceof PinRejected && cause.remaining <= 0) {
          onUsePassword();
          return;
        }

        setBusy(false);
      }
    },
    [busy, onUnlocked, onUsePassword, pin],
  );

  return (
    <Panel data-testid="pin-unlock">
      <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
        <span className="cursor">core unlock</span>
      </h1>
      <p className="text-muted mt-2 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        {email}
      </p>

      {hasPasskey ? (
        <Button
          type="button"
          onClick={() => void usePasskey()}
          disabled={busy}
          className="mt-8 w-full"
          data-testid="passkey-unlock"
        >
          unlock with a passkey
        </Button>
      ) : null}

      <form onSubmit={submit} className="mt-8 space-y-6" noValidate>
        <Field label="pin" htmlFor={pinId}>
          <Input
            id={pinId}
            name="pin"
            type="password"
            // `numeric` rather than `tel`: a phone shows a digit pad for both,
            // and this one does not carry the extra characters a dial pad has.
            inputMode="numeric"
            autoComplete="off"
            maxLength={MAX_PIN_LENGTH}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
            disabled={busy}
            data-testid="pin-input"
            required
          />
        </Field>

        {error ? (
          <p role="alert" className="text-danger font-mono text-xs" data-testid="pin-error">
            <span aria-hidden="true">! </span>
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={busy || pin.length < MIN_PIN_LENGTH}
          className="w-full"
          data-testid="pin-unlock-submit"
        >
          {busy ? '... unlocking' : 'unlock'}
        </Button>
      </form>

      <Button
        type="button"
        variant="ghost"
        onClick={onUsePassword}
        className="mt-6"
        data-testid="use-master-password"
      >
        use master password
      </Button>
    </Panel>
  );
}
