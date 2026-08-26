'use client';

import { Button, Panel, Warning } from '@core/ui';
import { useState } from 'react';

/**
 * The Emergency Kit.
 *
 * This is the recovery key — the Account Key itself — shown exactly once. With
 * it, the vault can be opened without the master password. Without it, a
 * forgotten password is permanent data loss.
 *
 * Two deliberate choices:
 *
 *   1. **Print rather than a generated PDF.** A PDF library would add several
 *      hundred kilobytes and a dependency to the one screen where a supply
 *      chain problem does the most damage. The browser's own print dialogue
 *      produces a PDF via "Save as PDF" and a paper copy via a printer, which
 *      is the whole requirement.
 *
 *   2. **Nothing here is uploaded, and nothing is stored.** The key exists in
 *      this component's memory and nowhere else. Navigating away loses it, and
 *      the confirmation says so rather than letting someone find out later.
 */

export interface EmergencyKitProps {
  email: string;
  recoveryKey: string;
}

export function EmergencyKit({ email, recoveryKey }: EmergencyKitProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  const grouped = recoveryKey.match(/.{1,8}/g)?.join(' ') ?? recoveryKey;

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      // Cleared from the clipboard is the user's problem, but the confirmation
      // should not linger as if the key were still there.
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <Panel className="print:border-black print:bg-white print:text-black">
        <h1 className="text-accent text-xl font-bold tracking-tight print:text-black">
          core — emergency kit
        </h1>
        <p className="text-muted mt-2 text-sm print:text-black">
          Print this page, or save it as a PDF, and store it somewhere physical.
        </p>

        <dl className="mt-8 space-y-4 font-mono text-sm">
          <div>
            <dt className="text-muted text-xs uppercase tracking-widest print:text-black">
              account
            </dt>
            <dd className="text-fg mt-1 print:text-black" data-testid="kit-email">
              {email}
            </dd>
          </div>
          <div>
            <dt className="text-muted text-xs uppercase tracking-widest print:text-black">
              recovery key
            </dt>
            <dd
              className="text-accent mt-1 break-all text-base leading-relaxed print:text-black"
              data-testid="kit-recovery-key"
            >
              {grouped}
            </dd>
          </div>
        </dl>

        <div className="mt-8 print:hidden">
          <Warning title="shown once, stored nowhere">
            This key was generated in your browser and has never been sent anywhere. Core cannot
            show it to you again. If you lose both this and your master password, the vault is
            unrecoverable — there is no support request that changes that.
          </Warning>
        </div>

        <p className="text-muted mt-6 hidden font-mono text-xs print:block print:text-black">
          Anyone holding this page can open the vault. Store it as you would a spare house key.
        </p>

        <div className="mt-8 flex flex-wrap gap-3 print:hidden">
          <Button type="button" onClick={() => window.print()}>
            print / save as pdf
          </Button>
          <Button type="button" variant="ghost" onClick={copy} data-testid="kit-copy">
            {copied ? 'copied' : 'copy key'}
          </Button>
        </div>

        <div className="border-line mt-8 border-t pt-6 print:hidden">
          <label className="flex cursor-pointer items-start gap-3 font-mono text-xs">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              data-testid="kit-acknowledge"
              className="accent-accent mt-0.5"
            />
            <span className="text-fg">
              I have stored this recovery key somewhere safe. I understand it cannot be shown again.
            </span>
          </label>

          <Button
            type="button"
            disabled={!acknowledged}
            onClick={() => {
              window.location.href = '/login';
            }}
            className="mt-6 w-full"
            data-testid="kit-continue"
          >
            continue to unlock
          </Button>
        </div>
      </Panel>
    </main>
  );
}
