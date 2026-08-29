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

interface LiveSession {
  readonly id: string;
  readonly startedAt: number | null;
  readonly expiresAt: number;
  readonly current: boolean;
}

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

/**
 * The sessions that can currently open this account.
 *
 * The actionable half of this screen. Noticing a sign-in from somewhere
 * unfamiliar is only useful if there is something to do about it.
 *
 * Nothing is stored about the device — no address, no user agent, not even
 * hashed — so a row says "this one" or "started three days ago" and nothing
 * more. Naming them would mean recording a fingerprint for every sign-in, which
 * is a worse trade than a vaguer list.
 */
function Sessions() {
  const [live, setLive] = useState<readonly LiveSession[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function load(): Promise<void> {
    try {
      const response = await fetch('/api/auth/sessions');
      if (!response.ok) throw new Error('no');

      const body = (await response.json()) as { sessions: LiveSession[] };
      setLive(body.sessions);
    } catch {
      setError('Could not load the sessions for this account.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function revoke(id: string): Promise<void> {
    setBusy(id);
    try {
      await fetch('/api/auth/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      // Re-read rather than remove the row locally: the server decides what is
      // still live, and a list that disagreed with it would be the one thing
      // this screen cannot afford.
      await load();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="border-line mt-8 border-t pt-6">
      <h3 className="text-accent-dim mb-2 font-mono text-xs tracking-widest uppercase">
        open sessions
      </h3>
      <p className="text-muted mb-4 font-mono text-xs leading-relaxed">
        <span aria-hidden="true">&gt; </span>
        Nothing is stored about the device a session came from, so they are told apart by when they
        started. Ending one signs that browser out; it does not change your master password.
      </p>

      {error ? (
        <p className="text-danger font-mono text-xs" data-testid="sessions-error">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : live === null ? (
        <p className="text-muted font-mono text-xs" data-testid="sessions-loading">
          <span aria-hidden="true">&gt; </span>
          loading…
        </p>
      ) : (
        <ul className="border-line border-t" data-testid="sessions-list">
          {live.map((entry) => (
            <li
              key={entry.id}
              className="border-line flex items-center justify-between gap-3 border-b py-3"
              data-testid="session-row"
            >
              <span
                className={
                  entry.current ? 'text-accent font-mono text-xs' : 'text-muted font-mono text-xs'
                }
              >
                {entry.current ? 'this browser' : `started ${when(entry.startedAt)}`}
              </span>
              {entry.current ? (
                <span className="text-accent-dim font-mono text-[11px]">in use</span>
              ) : (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => void revoke(entry.id)}
                  disabled={busy === entry.id}
                  data-testid="revoke-session"
                >
                  {busy === entry.id ? '...' : 'end it'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

      <Sessions />

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
