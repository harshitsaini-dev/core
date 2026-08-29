'use client';

import type { DecryptedItem } from '@core/shared';
import { Button, Field, Input, Panel, RadioGroup, Warning } from '@core/ui';
import { useId, useState } from 'react';
import { CONFIRM_PHRASE, exportFilename, toCsv, toJson } from '@/lib/client/plaintext-export';
import { toast } from '@/lib/client/toast-store';

/**
 * Exporting a vault in the clear.
 *
 * The gate is the feature. Everything else here is four lines of string
 * building, and the reason this screen is careful is that the file it produces
 * is the single worst thing that can come out of this product: every password,
 * readable, in a folder nobody empties, syncing to somewhere nobody remembers
 * choosing.
 *
 * So it asks for two things that a misclick cannot supply — a typed phrase and
 * the master password — and it says what the file is before either of them.
 * Neither is security theatre: this is not a decision to arrive at by pressing
 * a button that happened to be under the cursor.
 *
 * It exists at all because a vault you cannot leave is a vault you are locked
 * into, and a password manager that holds your data hostage is worse than one
 * that lets you leave badly.
 */
export function PlaintextExportPanel({
  items,
  onBack,
}: {
  readonly items: readonly DecryptedItem[];
  readonly onBack: () => void;
}) {
  const phraseId = useId();
  const passwordId = useId();

  const [kind, setKind] = useState<'csv' | 'json'>('csv');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const live = items.filter((item) => item.deletedAt === null);
  const ready = phrase.trim() === CONFIRM_PHRASE && password !== '';

  async function run(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || busy) return;

    setBusy(true);
    setError('');

    try {
      /*
       * A real check, despite happening locally and with the vault already
       * open. The stored wrapper will not open under a key derived from the
       * wrong password — that is AES-GCM's authentication tag refusing, not a
       * comparison this code performs and could get wrong.
       *
       * What it establishes is that the person at the keyboard is the one who
       * unlocked the vault, which may have been hours ago on a machine they
       * have since walked away from.
       */
      const { verifyMasterPassword } = await import('@/lib/client/auth-verify');
      if (!(await verifyMasterPassword(password))) {
        setError('That master password is not right.');
        return;
      }

      const body = kind === 'csv' ? toCsv(live) : toJson(live);
      const file = new Blob([body], { type: kind === 'csv' ? 'text/csv' : 'application/json' });
      const url = URL.createObjectURL(file);

      const link = document.createElement('a');
      link.href = url;
      link.download = exportFilename(kind);
      link.click();
      URL.revokeObjectURL(url);

      toast(`${live.length} items written in the clear. Delete the file when you are done.`, {
        tone: 'danger',
      });
      onBack();
    } catch {
      setError('Could not check that password. Nothing has been exported.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="mt-6" data-testid="plaintext-export">
      <h2 className="text-danger typewriter mb-6 font-mono text-sm tracking-widest uppercase">
        export in the clear
      </h2>

      <Warning title="this file is not encrypted">
        Every password, note, card number and key in your vault, readable by anything that opens a
        text file. It will sit in your Downloads folder until you delete it, and it will be copied
        by whatever backs that folder up. There is no way to un-export it.
      </Warning>

      <p className="text-muted mt-4 font-mono text-xs leading-relaxed">
        <span aria-hidden="true">&gt; </span>
        For moving to another password manager, which is the one thing an encrypted backup cannot
        do. If that is not what you are doing, use <span className="text-accent">backup</span>{' '}
        instead — same data, encrypted, restorable here.
      </p>

      <form onSubmit={(event) => void run(event)} className="mt-8 space-y-6" noValidate>
        <RadioGroup
          name="export-format"
          legend="format"
          value={kind}
          onChange={(next) => setKind(next as 'csv' | 'json')}
          options={[
            { value: 'csv', label: 'csv — what other password managers read' },
            { value: 'json', label: 'json — keeps line breaks and structure' },
          ]}
        />

        <Field label={`type "${CONFIRM_PHRASE}"`} htmlFor={phraseId}>
          <Input
            id={phraseId}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            autoComplete="off"
            disabled={busy}
            data-testid="export-phrase"
          />
        </Field>

        <Field label="master password" htmlFor={passwordId}>
          <Input
            id={passwordId}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={busy}
            data-testid="export-password"
          />
        </Field>

        {error ? (
          <p role="alert" className="text-danger font-mono text-xs" data-testid="export-error">
            <span aria-hidden="true">! </span>
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="danger" disabled={!ready || busy} data-testid="export-run">
          {busy ? '... checking' : `export ${live.length} items in the clear`}
        </Button>
      </form>

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-8"
        data-testid="export-back"
      >
        back
      </Button>
    </Panel>
  );
}
