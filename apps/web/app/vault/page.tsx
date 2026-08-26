'use client';

import { Button, Panel } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { startAutoLock, useVault } from '@/lib/client/vault-store';

/**
 * The vault.
 *
 * A placeholder until Phase 3 builds the real thing. It exists now because
 * unlock has to land somewhere, and because it is the first place the lock
 * state is observable — worth having under test before there are items to lose.
 */
export default function VaultPage() {
  const router = useRouter();
  const state = useVault((vault) => vault.state);
  const lockedAutomatically = useVault((vault) => vault.lockedAutomatically);
  const lock = useVault((vault) => vault.lock);
  const panic = useVault((vault) => vault.panic);

  useEffect(() => startAutoLock(), []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <Panel>
        <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
          <span className="cursor">core</span>
        </h1>

        <p className="text-muted mt-4 font-mono text-sm" data-testid="vault-state">
          <span aria-hidden="true">&gt; </span>
          vault {state}
        </p>

        {state === 'unlocked' ? (
          <>
            <p className="text-muted mt-4 font-mono text-xs">
              Keys are held in memory only. Locking releases them; nothing is written to disk.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button type="button" variant="ghost" onClick={() => lock(false)} data-testid="lock">
                lock
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => void panic()}
                data-testid="panic"
              >
                panic — lock and sign out
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted mt-4 font-mono text-xs" data-testid="locked-reason">
              {lockedAutomatically
                ? 'Locked automatically after a period of inactivity.'
                : 'Your master password is needed to unlock.'}
            </p>
            <Button
              type="button"
              onClick={() => router.push('/login')}
              className="mt-8"
              data-testid="go-unlock"
            >
              unlock
            </Button>
          </>
        )}
      </Panel>
    </main>
  );
}
