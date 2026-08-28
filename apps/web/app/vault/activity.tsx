'use client';

import { Button, Panel, Warning } from '@core/ui';
import { useEffect, useState } from 'react';

/**
 * Account activity.
 *
 * This exists for one moment: somebody suspects another person has been in
 * their vault and wants to know. Everything on the screen is arranged around
 * making that answerable, and around not implying more than the server actually
 * knows.
 *
 * Two things are deliberately absent. The address and the user agent are stored
 * hashed and are not shown, because a hash on screen is noise dressed as
 * evidence. And unlocking is not here at all — unlocking happens entirely in
 * the browser and never reaches the server, so a list claiming to show unlocks
 * would be showing sign-ins and calling them something else. The panel says so
 * rather than leaving the gap to be discovered.
 */

interface Entry {
  readonly id: string;
  readonly event: string;
  readonly country: string | null;
  readonly at: number | null;
}

/** What each event means, in words rather than in database vocabulary. */
const LABELS: Record<string, { text: string; tone: 'accent' | 'warning' | 'danger' }> = {
  signup: { text: 'account created', tone: 'accent' },
  login: { text: 'signed in', tone: 'accent' },
  login_failed: { text: 'failed sign-in', tone: 'warning' },
  logout: { text: 'signed out', tone: 'accent' },
  password_changed: { text: 'master password changed', tone: 'warning' },
  account_locked: { text: 'account locked after repeated failures', tone: 'danger' },
  session_reuse_detected: { text: 'an old session token was replayed', tone: 'danger' },
  session_revoked: { text: 'session revoked', tone: 'warning' },
  device_trusted: { text: 'device trusted', tone: 'warning' },
  export: { text: 'vault exported', tone: 'warning' },
  unlock: { text: 'unlocked', tone: 'accent' },
};

const TONES = {
  accent: 'text-accent',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

function when(at: number | null): string {
  if (at === null) return 'unknown time';

  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export function ActivityPanel({ onBack }: { readonly onBack: () => void }) {
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const response = await fetch('/api/auth/activity');
        if (!response.ok) throw new Error('The server would not answer.');

        const body = (await response.json()) as { events: Entry[] };
        if (live) setEntries(body.events);
      } catch {
        // Reported rather than shown as an empty list. "Nothing has happened"
        // is the single most misleading thing this screen could say to somebody
        // who opened it because they think something has.
        if (live) setError('Could not load the activity for this account.');
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return (
    <Panel className="mt-6" data-testid="activity">
      <h2 className="text-accent typewriter mb-2 font-mono text-sm tracking-widest uppercase">
        account activity
      </h2>
      <p className="text-muted mb-6 font-mono text-xs leading-relaxed">
        <span aria-hidden="true">&gt; </span>
        What has reached the server for this account. Unlocking is not here — that happens in your
        browser and never leaves it, so the server has nothing to report. Addresses are stored
        hashed and cannot be shown.
      </p>

      {error ? (
        <Warning title="could not load it">{error}</Warning>
      ) : entries === null ? (
        <p className="text-muted font-mono text-xs" data-testid="activity-loading">
          <span aria-hidden="true">&gt; </span>
          loading…
        </p>
      ) : entries.length === 0 ? (
        <p className="text-muted font-mono text-xs" data-testid="activity-empty">
          <span aria-hidden="true">&gt; </span>
          nothing recorded yet
        </p>
      ) : (
        <ul className="border-line border-t" data-testid="activity-list">
          {entries.map((entry) => {
            const label = LABELS[entry.event] ?? { text: entry.event, tone: 'warning' as const };

            return (
              <li
                key={entry.id}
                className="border-line flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b py-3"
                data-testid="activity-row"
              >
                <span className={`${TONES[label.tone]} font-mono text-xs`}>{label.text}</span>
                <span className="text-muted font-mono text-[11px]">
                  {entry.country ? `${entry.country} · ` : ''}
                  {when(entry.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-8"
        data-testid="activity-back"
      >
        back
      </Button>
    </Panel>
  );
}
