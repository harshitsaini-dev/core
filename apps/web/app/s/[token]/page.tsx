'use client';

import { Button, Panel } from '@core/ui';
import { use, useEffect, useState } from 'react';
import { keyFromFragment, openShare } from '@/lib/client/share';
import { copySecret } from '@/lib/client/clipboard';
import { toast } from '@/lib/client/toast-store';

/**
 * Opening a shared secret.
 *
 * The one screen in this app that runs without an account, so it says what it
 * is and what is about to happen before anything is spent. The reveal is a
 * button and not something that happens on load: this page is fetched by every
 * chat client's preview bot before a person ever sees it, and burning the share
 * on load would give the only view to a crawler.
 */
export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [state, setState] = useState<'checking' | 'ready' | 'gone' | 'opened' | 'unreadable'>(
    'checking',
  );
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // A look, not a spend. See the note on the route.
    void fetch(`/api/share/${encodeURIComponent(token)}`)
      .then((response) => response.json() as Promise<{ status: string }>)
      .then((body) => setState(body.status === 'ready' ? 'ready' : 'gone'))
      .catch(() => setState('gone'));
  }, [token]);

  async function reveal(): Promise<void> {
    setBusy(true);
    try {
      const response = await fetch(`/api/share/${encodeURIComponent(token)}`, { method: 'POST' });
      const body = (await response.json()) as { status: string; payload?: string };

      if (body.status !== 'ready' || !body.payload) {
        setState('gone');
        return;
      }

      const text = await openShare(body.payload, keyFromFragment());

      // The share is spent either way — that is what one-time means, and
      // pretending otherwise would send somebody back to a link that is gone.
      if (text === null) {
        setState('unreadable');
        return;
      }

      setSecret(text);
      setState('opened');
    } catch {
      setState('gone');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto w-full max-w-lg px-4 py-16">
      <h1 className="text-accent text-glow mb-8 text-lg font-bold tracking-tight">
        <span className="cursor">core</span>
      </h1>

      <Panel>
        <h2 className="text-accent typewriter mb-6 font-mono text-sm tracking-widest uppercase">
          a shared secret
        </h2>

        {state === 'checking' ? (
          <p className="text-muted font-mono text-sm" data-testid="share-checking">
            <span aria-hidden="true">&gt; </span>
            looking...
          </p>
        ) : null}

        {state === 'ready' ? (
          <>
            <p className="text-fg font-mono text-sm leading-relaxed" data-testid="share-ready">
              <span aria-hidden="true">&gt; </span>
              Somebody sent you this through Core. It can be opened once — after that this link
              stops working, for you and for anyone else who has it.
            </p>
            <p className="text-muted mt-4 font-mono text-xs leading-relaxed">
              <span aria-hidden="true">&gt; </span>
              Nothing has been read yet. Open it when you are ready to keep what is inside.
            </p>
            <div className="mt-6">
              <Button onClick={() => void reveal()} disabled={busy} data-testid="share-reveal">
                {busy ? 'opening...' : 'open it'}
              </Button>
            </div>
          </>
        ) : null}

        {state === 'opened' ? (
          <>
            <pre
              className="border-line text-fg secret mt-2 border p-4 font-mono text-sm break-all whitespace-pre-wrap"
              data-testid="share-secret"
            >
              {secret}
            </pre>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                onClick={() => {
                  void copySecret(secret).then((copied) => {
                    toast(
                      copied
                        ? 'Copied. The clipboard clears in 30 seconds.'
                        : 'The browser refused clipboard access.',
                      copied ? {} : { tone: 'danger' },
                    );
                  });
                }}
                data-testid="share-copy"
              >
                copy
              </Button>
            </div>
            <p className="text-warning mt-6 font-mono text-xs leading-relaxed">
              <span aria-hidden="true">! </span>
              This link is now spent. Reloading this page will show nothing, so keep what is above
              before you leave it.
            </p>
          </>
        ) : null}

        {state === 'unreadable' ? (
          <p
            className="text-danger font-mono text-sm leading-relaxed"
            data-testid="share-unreadable"
          >
            <span aria-hidden="true">! </span>
            This link could not be opened. The part after the <code>#</code> is the key, and some
            chat apps cut it off — ask the sender for the whole link. The share has been spent
            either way, so they will need to make a new one.
          </p>
        ) : null}

        {state === 'gone' ? (
          <p className="text-muted font-mono text-sm leading-relaxed" data-testid="share-gone">
            <span aria-hidden="true">&gt; </span>
            There is nothing here. This link was already opened, or it expired, or it was never real
            — this page cannot tell you which, on purpose. Ask whoever sent it for another.
          </p>
        ) : null}
      </Panel>
    </main>
  );
}
