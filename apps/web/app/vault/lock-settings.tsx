'use client';

import { Button, Checkbox, Panel, RadioGroup, Warning } from '@core/ui';
import { useEffect } from 'react';
import { AUTO_LOCK_CHOICES, useLockSettings } from '@/lib/client/lock-settings';

/**
 * When the vault locks itself.
 *
 * Both controls here make the product less convenient on purpose, so both are
 * stated in terms of what they cost rather than what they protect. A security
 * setting people find annoying and switch off protects nothing, and one they
 * do not understand gets left on the wrong value.
 *
 * `never` is offered because refusing to offer it does not stop anyone — it
 * moves them to a vault that leaves itself open by default, which is worse.
 * What it does get is the plainest wording on the screen.
 */

/**
 * The stored preference, read after mount.
 *
 * Never during render: the server rendered the defaults, and reading
 * `localStorage` on the way past would disagree with that and cost the whole
 * tree.
 */
function useHydratedSettings() {
  const hydrate = useLockSettings((settings) => settings.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return useLockSettings();
}

export function LockSettingsPanel({ onBack }: { readonly onBack: () => void }) {
  const { autoLockMs, lockOnBlur, setAutoLockMs, setLockOnBlur } = useHydratedSettings();

  const never = !Number.isFinite(autoLockMs);

  return (
    <Panel className="mt-6" data-testid="lock-settings">
      <h2 className="text-accent typewriter mb-2 font-mono text-sm tracking-widest uppercase">
        auto-lock
      </h2>
      <p className="text-muted mb-6 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        Locking drops the keys from memory. The session stays; unlocking needs the master password
        again, not another sign-in.
      </p>

      <RadioGroup
        name="auto-lock"
        legend="lock after"
        value={never ? 'never' : String(autoLockMs)}
        onChange={(value) =>
          setAutoLockMs(value === 'never' ? Number.POSITIVE_INFINITY : Number(value))
        }
        options={AUTO_LOCK_CHOICES.map((choice) => ({
          value: Number.isFinite(choice.ms) ? String(choice.ms) : 'never',
          label: choice.label,
        }))}
      />

      {never ? (
        <div className="mt-4" data-testid="never-warning">
          <Warning title="this vault will stay open">
            Nothing will lock it but you. Anyone who reaches this device while the tab is open
            reaches everything in it, and closing the laptop lid is not closing the vault.
          </Warning>
        </div>
      ) : null}

      <div className="border-line mt-8 border-t pt-6">
        <Checkbox
          name="lock-on-blur"
          checked={lockOnBlur}
          onChange={(event) => setLockOnBlur(event.target.checked)}
          label="lock as soon as this tab is hidden"
          data-testid="lock-on-blur"
        />
        <p className="text-muted mt-3 font-mono text-xs leading-relaxed">
          <span aria-hidden="true">&gt; </span>
          Switching tabs, minimising, or locking the screen locks the vault at once instead of
          waiting for the timer. It also means every trip to another tab costs a master password on
          the way back, which is the trade.
        </p>
      </div>

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-8"
        data-testid="lock-settings-back"
      >
        back
      </Button>
    </Panel>
  );
}
