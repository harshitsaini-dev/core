'use client';

import { itemSubtitle } from '@core/shared';
import type { DecryptedItem } from '@core/shared';
import { Button, Input, Panel } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { clearClipboardNow, copySecret, pulse } from '@/lib/client/clipboard';
import { activeItems, trashedItems, useItems, watchConnectivity } from '@/lib/client/items-store';
import { pinFavourites, search, sortItems } from '@/lib/client/search';
import { startAutoLock, useVault } from '@/lib/client/vault-store';
import { ItemForm } from './item-form';
import { TotpCode } from './totp-code';

/**
 * The vault.
 *
 * Search, sort and filter all run here, over decrypted items held in memory,
 * because the server has ciphertext and could not do any of it. That is a
 * constraint rather than a choice — and it is also why searching is instant.
 */

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'trash' };

export default function VaultPage() {
  const router = useRouter();

  const state = useVault((vault) => vault.state);
  const lockedAutomatically = useVault((vault) => vault.lockedAutomatically);
  const lock = useVault((vault) => vault.lock);
  const panic = useVault((vault) => vault.panic);

  const items = useItems((store) => store.items);
  const loading = useItems((store) => store.loading);
  const error = useItems((store) => store.error);
  const undecryptable = useItems((store) => store.undecryptable);
  const online = useItems((store) => store.online);
  const pending = useItems((store) => store.pending);
  const load = useItems((store) => store.load);
  const reset = useItems((store) => store.reset);

  const [view, setView] = useState<View>({ kind: 'list' });
  const [query, setQuery] = useState('');

  useEffect(() => startAutoLock(), []);
  useEffect(() => watchConnectivity(), []);

  useEffect(() => {
    if (state === 'unlocked') {
      void load();
    } else {
      // Locking drops the decrypted items along with the keys, and takes the
      // clipboard with them. Leaving either behind would make the lock
      // cosmetic.
      reset();
      void clearClipboardNow();
    }
  }, [state, load, reset]);

  const visible = useMemo(() => {
    const live = activeItems(items);
    const ranked =
      query.trim() === ''
        ? sortItems(live, 'recent')
        : search(live, query).map((result) => result.item);
    return pinFavourites(ranked);
  }, [items, query]);

  const trashed = useMemo(() => trashedItems(items), [items]);

  if (state === 'locked') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
        <Panel>
          <h1 className="text-accent text-glow text-xl font-bold tracking-tight">
            <span className="cursor">core</span>
          </h1>
          <p className="text-muted mt-4 font-mono text-sm" data-testid="vault-state">
            <span aria-hidden="true">&gt; </span>
            vault locked
          </p>
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
        </Panel>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-accent text-glow text-lg font-bold tracking-tight">
          <span className="cursor">core</span>
        </h1>
        <div className="flex items-center gap-4">
          <ConnectionStatus online={online} pending={pending} />
          <p className="text-muted font-mono text-xs" data-testid="vault-state">
            vault unlocked
          </p>
        </div>
      </header>

      {view.kind === 'list' ? (
        <>
          <div className="mt-6 flex flex-wrap gap-3">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="search"
              aria-label="search"
              data-testid="search"
              className="flex-1"
            />
            <Button type="button" onClick={() => setView({ kind: 'new' })} data-testid="new-item">
              new
            </Button>
          </div>

          {error ? (
            <p
              role="status"
              className="text-warning mt-4 font-mono text-xs"
              data-testid="sync-error"
            >
              <span aria-hidden="true">! </span>
              {error}
            </p>
          ) : null}

          {undecryptable.length > 0 ? (
            <p role="alert" className="text-danger mt-4 font-mono text-xs">
              <span aria-hidden="true">! </span>
              {undecryptable.length} item(s) could not be decrypted on this device.
            </p>
          ) : null}

          <ItemList
            items={visible}
            loading={loading}
            query={query}
            onEdit={(id) => setView({ kind: 'edit', id })}
          />

          <footer className="border-line mt-10 flex flex-wrap gap-3 border-t pt-6">
            <Button type="button" variant="ghost" onClick={() => lock(false)} data-testid="lock">
              lock
            </Button>
            {trashed.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setView({ kind: 'trash' })}
                data-testid="open-trash"
              >
                trash ({trashed.length})
              </Button>
            ) : null}
            <Button type="button" variant="danger" onClick={() => void panic()} data-testid="panic">
              panic
            </Button>
          </footer>
        </>
      ) : null}

      {view.kind === 'new' || view.kind === 'edit' ? (
        <Panel className="mt-6">
          <h2 className="text-accent mb-6 font-mono text-sm tracking-widest uppercase">
            {view.kind === 'new' ? 'new item' : 'edit item'}
          </h2>
          <ItemForm
            {...(view.kind === 'edit'
              ? { existing: items.find((item) => item.id === view.id) }
              : {})}
            onDone={() => setView({ kind: 'list' })}
            onCancel={() => setView({ kind: 'list' })}
          />
        </Panel>
      ) : null}

      {view.kind === 'trash' ? (
        <Trash items={trashed} onBack={() => setView({ kind: 'list' })} />
      ) : null}
    </main>
  );
}

/**
 * Connection state.
 *
 * A dot and a word, not a dot alone. Colour is the wrong carrier here twice
 * over: the palette is one hue, and "is this saved" is the question a user most
 * needs an unambiguous answer to.
 *
 * Being offline is reported as a fact rather than a problem — the vault is
 * fully usable in that state, and an alarming banner would suggest otherwise.
 */
function ConnectionStatus({ online, pending }: { online: boolean; pending: number }) {
  const label = !online ? 'offline' : pending > 0 ? `syncing ${pending}` : 'synced';

  return (
    <p
      className={
        online && pending === 0
          ? 'text-accent-dim font-mono text-xs'
          : 'text-warning font-mono text-xs'
      }
      data-testid="connection-status"
      aria-live="polite"
    >
      <span aria-hidden="true">{online && pending === 0 ? '●' : '○'} </span>
      {label}
    </p>
  );
}

function ItemList({
  items,
  loading,
  query,
  onEdit,
}: {
  items: readonly DecryptedItem[];
  loading: boolean;
  query: string;
  onEdit: (id: string) => void;
}) {
  if (loading && items.length === 0) {
    return (
      <p className="text-muted mt-8 font-mono text-sm">
        <span aria-hidden="true">&gt; </span>
        loading vault...
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-muted mt-8 font-mono text-sm" data-testid="empty-state">
        <span aria-hidden="true">&gt; </span>
        {query.trim() === '' ? 'nothing stored yet' : `no match for "${query}"`}
      </p>
    );
  }

  return (
    <ul className="border-line mt-6 border-t" data-testid="item-list">
      {items.map((item) => (
        <ItemRow key={item.id} item={item} onEdit={onEdit} />
      ))}
    </ul>
  );
}

function ItemRow({ item, onEdit }: { item: DecryptedItem; onEdit: (id: string) => void }) {
  const [copied, setCopied] = useState<'username' | 'password' | null>(null);
  const [failed, setFailed] = useState(false);

  const markUsed = useItems((store) => store.markUsed);
  const setFavorite = useItems((store) => store.setFavorite);
  const remove = useItems((store) => store.remove);

  const fields = item.data.type === 'login' ? item.data.fields : null;

  async function copy(which: 'username' | 'password', value: string | undefined) {
    if (!value) return;

    const ok = await copySecret(value);
    setFailed(!ok);
    if (!ok) return;

    pulse();
    setCopied(which);
    void markUsed(item.id);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <li className="border-line border-b py-4" data-testid="item-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-fg truncate font-mono text-sm" data-testid="item-row-title">
            {item.favorite ? <span aria-label="favourite">★ </span> : null}
            {item.data.fields.title}
          </p>
          {item.data.type !== 'login' ? (
            <p className="text-accent-dim font-mono text-[10px] tracking-widest uppercase">
              {item.data.type}
            </p>
          ) : null}
          <p className="text-muted truncate font-mono text-xs">{itemSubtitle(item.data)}</p>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {fields?.username ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void copy('username', fields.username)}
              data-testid="copy-username"
            >
              {copied === 'username' ? 'copied' : 'user'}
            </Button>
          ) : null}
          {fields?.password ? (
            <Button
              type="button"
              onClick={() => void copy('password', fields.password)}
              data-testid="copy-password"
            >
              {copied === 'password' ? 'copied' : 'copy'}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            onClick={() => void setFavorite(item.id, !item.favorite)}
            aria-pressed={item.favorite}
            aria-label={item.favorite ? 'unpin' : 'pin'}
            data-testid="toggle-favorite"
          >
            {item.favorite ? 'unpin' : 'pin'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onEdit(item.id)}
            data-testid="edit-item"
          >
            edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void remove(item.id)}
            data-testid="delete-item"
          >
            delete
          </Button>
        </div>
      </div>

      {item.data.type === 'note' && item.data.fields.body ? (
        <details className="mt-3" data-testid="note-body-view">
          <summary className="text-muted cursor-pointer font-mono text-xs">
            <span aria-hidden="true">&gt; </span>
            read
          </summary>
          {/*
            Rendered as text, with line breaks preserved — never parsed as
            Markdown or HTML. A note is the easiest place in the product for
            hostile content to arrive, and turning it into markup would inject
            it into the one origin that holds the vault keys.
          */}
          <p className="text-fg mt-2 max-h-64 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {item.data.fields.body}
          </p>
        </details>
      ) : null}

      {fields?.totpSecret ? (
        <div className="mt-3" data-testid="item-totp-row">
          <TotpCode secret={fields.totpSecret} />
        </div>
      ) : null}

      {fields?.recoveryCodes?.length ? (
        <p className="text-muted mt-2 font-mono text-xs" data-testid="item-recovery-count">
          <span aria-hidden="true">&gt; </span>
          {fields.recoveryCodes.length} recovery code(s) stored
        </p>
      ) : null}

      {fields?.customFields?.length ? (
        <dl className="mt-2 space-y-1" data-testid="item-custom-fields">
          {fields.customFields.map((field, index) => (
            <div key={index} className="flex gap-2 font-mono text-xs">
              <dt className="text-muted">{field.label}</dt>
              <dd className="text-fg">
                {/* Hidden fields stay hidden in the list. Revealing them here
                    would undo the reason somebody marked them hidden. */}
                {field.hidden ? '••••••••' : field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {failed ? (
        <p role="alert" className="text-danger mt-2 font-mono text-xs">
          <span aria-hidden="true">! </span>
          The browser refused clipboard access. Reveal the value and copy it manually.
        </p>
      ) : copied ? (
        <p className="text-muted mt-2 font-mono text-xs" aria-live="polite">
          <span aria-hidden="true">&gt; </span>
          Clipboard clears in 30 seconds, as long as this tab stays open.
        </p>
      ) : null}
    </li>
  );
}

function Trash({ items, onBack }: { items: readonly DecryptedItem[]; onBack: () => void }) {
  const restore = useItems((store) => store.restore);

  return (
    <Panel className="mt-6">
      <h2 className="text-accent mb-2 font-mono text-sm tracking-widest uppercase">trash</h2>
      <p className="text-muted mb-6 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        Deleted items stay here for 30 days.
      </p>

      <ul className="border-line border-t" data-testid="trash-list">
        {items.map((item) => (
          <li
            key={item.id}
            className="border-line flex items-center justify-between gap-3 border-b py-4"
          >
            <span className="text-muted truncate font-mono text-sm">{item.data.fields.title}</span>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void restore(item.id)}
              data-testid="restore-item"
            >
              restore
            </Button>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-6"
        data-testid="trash-back"
      >
        back
      </Button>
    </Panel>
  );
}
