'use client';

import {
  BACKUP_FORMAT,
  FOLDER_COLORS,
  backupContents,
  backupFilename,
  detectColumns,
  mappingIsUsable,
  parseCsv,
  rowsToItems,
  collectTags,
  describePasswordAge,
  itemSubtitle,
  orderFolders,
  passwordAgeDays,
  readBackup,
} from '@core/shared';
import type { ColumnMapping, DecryptedFolder, DecryptedItem, ImportField } from '@core/shared';
import type { Layout } from '@/lib/client/view-store';
import { Button, Checkbox, Input, Panel, Select, Warning } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearClipboardNow, copySecret, pulse } from '@/lib/client/clipboard';
import { fetchItemHistory } from '@/lib/client/vault-api';
import type { ItemVersion } from '@/lib/client/vault-api';
import { usePullToRefresh, useSwipe } from '@/lib/client/gestures';
import { PasswordChangeRejected, changeMasterPassword } from '@/lib/client/auth';
import { BackupPasswordWrong, buildBackup, restoreBackup } from '@/lib/client/backup';
import { activeProjects, useEnv } from '@/lib/client/env-store';
import { usePrivacy } from '@/lib/client/privacy-store';
import { toast } from '@/lib/client/toast-store';
import { useView } from '@/lib/client/view-store';
import {
  activeFolders,
  activeItems,
  trashedItems,
  useItems,
  watchConnectivity,
} from '@/lib/client/items-store';
import { pinFavourites, search, sortItems } from '@/lib/client/search';
import { startAutoLock, useVault } from '@/lib/client/vault-store';
import { CheckupPanel } from './checkup';
import { LockSettingsPanel } from './lock-settings';
import { PinSetupPanel } from './pin-setup';
import { CommandPalette } from './command-palette';
import type { Command } from './command-palette';
import { ItemForm } from './item-form';
import { TotpCode } from './totp-code';

/**
 * The vault.
 *
 * Search, sort and filter all run here, over decrypted items held in memory,
 * because the server has ciphertext and could not do any of it. That is a
 * constraint rather than a choice — and it is also why searching is instant.
 */

type View =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'edit'; id: string }
  | { kind: 'trash' }
  | { kind: 'folders' }
  | { kind: 'backup' }
  | { kind: 'password' }
  | { kind: 'checkup' }
  | { kind: 'lock-settings' }
  | { kind: 'pin' }
  | { kind: 'import' };

/**
 * Which items the filters admit.
 *
 * `null` means everything; `'none'` means the items filed nowhere, which is a
 * genuinely different question from "all items" once folders exist.
 */
type FolderFilter = string | 'none' | null;

/**
 * Whether a keystroke belongs to whatever the user is typing into.
 *
 * Single-letter shortcuts are only safe if they never fire mid-word. Getting
 * this wrong means a title containing "n" opens a second new-item form while
 * somebody is still naming the first.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export default function VaultPage() {
  const router = useRouter();

  const state = useVault((vault) => vault.state);
  const lockedAutomatically = useVault((vault) => vault.lockedAutomatically);
  const lock = useVault((vault) => vault.lock);
  const panic = useVault((vault) => vault.panic);

  const items = useItems((store) => store.items);
  const folders = useItems((store) => store.folders);
  const loading = useItems((store) => store.loading);
  const error = useItems((store) => store.error);
  const undecryptable = useItems((store) => store.undecryptable);
  const online = useItems((store) => store.online);
  const pending = useItems((store) => store.pending);
  const load = useItems((store) => store.load);
  const reset = useItems((store) => store.reset);

  const [view, setView] = useState<View>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [folderFilter, setFolderFilter] = useState<FolderFilter>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const layout = useView((state) => state.layout);
  const setLayout = useView((state) => state.setLayout);
  const hydrateLayout = useView((state) => state.hydrate);
  const selecting = useView((state) => state.selecting);
  const startSelecting = useView((state) => state.startSelecting);
  const stopSelecting = useView((state) => state.stopSelecting);

  const blurred = usePrivacy((state) => state.blurred);
  const toggleBlur = usePrivacy((state) => state.toggle);
  const setBlur = usePrivacy((state) => state.set);

  useEffect(() => startAutoLock(), []);
  // After mount, not during render: reading storage while rendering disagrees
  // with what the server produced and React throws the tree away.
  useEffect(() => hydrateLayout(), [hydrateLayout]);
  useEffect(() => watchConnectivity(), []);

  useEffect(() => {
    if (state === 'unlocked') {
      void load();
    } else {
      // Locking drops the decrypted items along with the keys, and takes the
      // clipboard with them. Leaving either behind would make the lock
      // cosmetic.
      reset();
      stopSelecting();
      void clearClipboardNow();
    }
  }, [state, load, reset, stopSelecting]);

  const live = useMemo(() => activeItems(items), [items]);

  const visible = useMemo(() => {
    // Filters narrow before search ranks. Ranking first and filtering after
    // would let a folder with three items show two, because the ones it hid
    // had already taken the top places.
    let pool = live;

    if (folderFilter === 'none') {
      pool = pool.filter((item) => item.folderId === null);
    } else if (folderFilter !== null) {
      pool = pool.filter((item) => item.folderId === folderFilter);
    }

    if (tagFilter !== null) {
      pool = pool.filter((item) => item.data.fields.tags?.includes(tagFilter) ?? false);
    }

    const ranked =
      query.trim() === ''
        ? sortItems(pool, 'recent')
        : search(pool, query).map((result) => result.item);
    return pinFavourites(ranked);
  }, [live, query, folderFilter, tagFilter]);

  const trashed = useMemo(() => trashedItems(items), [items]);

  const openItem = useCallback((id: string) => setView({ kind: 'edit', id }), []);

  const commands = useMemo<Command[]>(
    () => [
      { id: 'new', label: 'new item', hint: 'n', run: () => setView({ kind: 'new' }) },
      { id: 'folders', label: 'manage folders', run: () => setView({ kind: 'folders' }) },
      { id: 'trash', label: 'open trash', run: () => setView({ kind: 'trash' }) },
      { id: 'checkup', label: 'security checkup', run: () => setView({ kind: 'checkup' }) },
      {
        id: 'lock-settings',
        label: 'auto-lock settings',
        run: () => setView({ kind: 'lock-settings' }),
      },
      { id: 'pin', label: 'quick unlock pin', run: () => setView({ kind: 'pin' }) },
      {
        id: 'clear-clipboard',
        label: 'clear the clipboard now',
        run: () => void clearClipboardNow(),
      },
      { id: 'blur', label: 'blur every value on screen', hint: 'b', run: toggleBlur },
      { id: 'lock', label: 'lock the vault', hint: 'l', run: () => lock(false) },
    ],
    // Delete and panic are deliberately absent: see the note in
    // command-palette.tsx. Nothing irreversible should be one Enter away from a
    // fuzzy match.
    [lock, toggleBlur],
  );

  /**
   * Keyboard shortcuts.
   *
   * Ctrl/Cmd+K works anywhere, including inside a form — it is the way out of
   * whatever you are doing. The single-letter ones only fire when nothing is
   * focused for typing, which is what keeps "n" from appearing in a password.
   */
  useEffect(() => {
    if (state !== 'unlocked') return;

    const onKeyDown = (event: KeyboardEvent): void => {
      // Something nearer the keystroke already dealt with it — an open dropdown
      // closing on Escape, say. Without this check that same Escape also threw
      // away the form the dropdown was in.
      if (event.defaultPrevented) return;

      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      if (paletteOpen || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape' && !isTyping(event.target)) {
        setView({ kind: 'list' });
        return;
      }

      if (isTyping(event.target)) return;

      if (event.key === '/') {
        event.preventDefault();
        setView({ kind: 'list' });
        searchRef.current?.focus();
        return;
      }

      if (event.key === 'n') {
        event.preventDefault();
        setView({ kind: 'new' });
        return;
      }

      if (event.key === 'b') {
        event.preventDefault();
        toggleBlur();
        return;
      }

      if (event.key === 'l') {
        event.preventDefault();
        lock(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state, paletteOpen, lock, toggleBlur]);

  // The palette holds decrypted titles. Locking has to take it with them.
  useEffect(() => {
    if (state !== 'unlocked') setPaletteOpen(false);
  }, [state]);

  /**
   * The blur class lives on the document, not on this subtree.
   *
   * The palette and the toasts render outside it, and a switch that missed
   * either would be worse than no switch at all — it would say the screen was
   * covered while one part of it was not.
   */
  useEffect(() => {
    document.documentElement.classList.toggle('blurred', blurred);
    return () => document.documentElement.classList.remove('blurred');
  }, [blurred]);

  // Unlocked is the only state that has anything to hide, and leaving the class
  // behind would blur the lock screen.
  useEffect(() => {
    if (state !== 'unlocked') setBlur(false);
  }, [state, setBlur]);
  const tags = useMemo(() => collectTags(live), [live]);
  const visibleFolders = useMemo(() => orderFolders(activeFolders(folders)), [folders]);

  // A filter pointing at a folder that has since been deleted would show an
  // empty vault with no way back, so it falls away with the folder.
  useEffect(() => {
    if (
      folderFilter !== null &&
      folderFilter !== 'none' &&
      !visibleFolders.some((entry) => entry.folder.id === folderFilter)
    ) {
      setFolderFilter(null);
    }
  }, [folderFilter, visibleFolders]);

  useEffect(() => {
    if (tagFilter !== null && !tags.includes(tagFilter)) setTagFilter(null);
  }, [tagFilter, tags]);

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
    <main className="mx-auto min-h-dvh max-w-3xl px-4 pt-8 pb-28 sm:px-6 sm:pb-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-accent text-glow text-lg font-bold tracking-tight">
          <span className="cursor">core</span>
        </h1>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={toggleBlur}
            aria-pressed={blurred}
            data-testid="toggle-blur"
            className={
              blurred
                ? 'text-accent text-glow font-mono text-xs'
                : 'text-muted hover:text-accent font-mono text-xs'
            }
          >
            <span aria-hidden="true">{blurred ? '▨ ' : '▧ '}</span>
            {blurred ? 'blurred' : 'blur'}
          </button>
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
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="search"
              aria-label="search"
              data-testid="search"
              className="flex-1"
            />
            {query !== '' ? (
              // Replaces the browser's own clear button, which is hidden in
              // globals.css because it is drawn grey on a black field.
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                aria-label="clear search"
                data-testid="clear-search"
              >
                clear
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLayout(layout === 'list' ? 'grid' : 'list')}
              aria-label={layout === 'list' ? 'switch to grid' : 'switch to list'}
              data-testid="toggle-layout"
            >
              {layout === 'list' ? '▤ list' : '▦ grid'}
            </Button>
            {visible.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => (selecting ? stopSelecting() : startSelecting())}
                aria-pressed={selecting}
                data-testid="toggle-select"
              >
                {selecting ? 'done' : 'select'}
              </Button>
            ) : null}
            <Button type="button" onClick={() => setView({ kind: 'new' })} data-testid="new-item">
              new
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPaletteOpen(true)}
              data-testid="open-palette"
            >
              ⌘K
            </Button>
          </div>

          <Filters
            folders={visibleFolders}
            tags={tags}
            folderFilter={folderFilter}
            tagFilter={tagFilter}
            onFolder={setFolderFilter}
            onTag={setTagFilter}
            onManage={() => setView({ kind: 'folders' })}
          />

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

          {selecting ? <BulkBar visible={visible} folders={visibleFolders} /> : null}

          <PullToRefresh onRefresh={load}>
            <ItemList
              items={visible}
              loading={loading}
              query={query}
              layout={layout}
              selecting={selecting}
              onEdit={openItem}
            />
          </PullToRefresh>

          <footer className="border-line mt-10 flex flex-wrap gap-3 border-t pt-6">
            {/*
              Duplicated by the bottom bar on a phone, so hidden there — except
              panic, which stays. A destructive action does not belong in a
              navigation bar where a thumb rests between taps.
            */}
            <Button
              type="button"
              variant="ghost"
              onClick={() => lock(false)}
              data-testid="lock"
              className="hidden sm:inline-flex"
            >
              lock
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView({ kind: 'folders' })}
              data-testid="open-folders"
              className="hidden sm:inline-flex"
            >
              folders
            </Button>
            {/*
              router.push, not a link to a URL. The keys live in memory and a
              full page load drops them, which would land on a locked env
              screen a moment after leaving an unlocked vault.
            */}
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push('/env')}
              data-testid="open-env"
            >
              env
            </Button>
            {trashed.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setView({ kind: 'trash' })}
                data-testid="open-trash"
                className="hidden sm:inline-flex"
              >
                trash ({trashed.length})
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView({ kind: 'checkup' })}
              data-testid="open-checkup"
            >
              checkup
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView({ kind: 'lock-settings' })}
              data-testid="open-lock-settings"
            >
              auto-lock
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView({ kind: 'pin' })}
              data-testid="open-pin"
            >
              pin
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView({ kind: 'backup' })}
              data-testid="open-backup"
            >
              backup
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView({ kind: 'password' })}
              data-testid="open-password"
            >
              password
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView({ kind: 'import' })}
              data-testid="open-csv-import"
            >
              import
            </Button>
            <Button type="button" variant="danger" onClick={() => void panic()} data-testid="panic">
              panic
            </Button>
          </footer>
        </>
      ) : null}

      {view.kind === 'new' || view.kind === 'edit' ? (
        <Panel className="mt-6">
          <h2 className="text-accent typewriter mb-6 font-mono text-sm tracking-widest uppercase">
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

      <BottomNav
        view={view.kind}
        trashed={trashed.length}
        onGo={(kind) => setView({ kind })}
        onLock={() => lock(false)}
      />

      {paletteOpen ? (
        <CommandPalette
          items={live}
          commands={commands}
          onClose={() => setPaletteOpen(false)}
          onOpenItem={openItem}
        />
      ) : null}

      {view.kind === 'checkup' ? (
        <CheckupPanel items={live} onOpen={openItem} onBack={() => setView({ kind: 'list' })} />
      ) : null}

      {view.kind === 'lock-settings' ? (
        <LockSettingsPanel onBack={() => setView({ kind: 'list' })} />
      ) : null}

      {view.kind === 'pin' ? <PinSetupPanel onBack={() => setView({ kind: 'list' })} /> : null}

      {view.kind === 'backup' ? <BackupPanel onBack={() => setView({ kind: 'list' })} /> : null}

      {view.kind === 'password' ? <PasswordPanel onBack={() => setView({ kind: 'list' })} /> : null}

      {view.kind === 'import' ? <ImportPanel onBack={() => setView({ kind: 'list' })} /> : null}

      {view.kind === 'folders' ? (
        <Folders folders={visibleFolders} items={live} onBack={() => setView({ kind: 'list' })} />
      ) : null}
    </main>
  );
}

/**
 * What a selection can do.
 *
 * Three actions, and all three are things somebody would otherwise do one row
 * at a time. Delete offers undo, because a bulk delete is the single easiest
 * way to lose a lot at once — and unlike a single delete, it is not obvious
 * from the screen what just went.
 */
/** The "no folder" choice, as a value that cannot collide with a folder id. */
const UNFILED = '__unfiled__';

function BulkBar({
  visible,
  folders,
}: {
  visible: readonly DecryptedItem[];
  folders: readonly { folder: DecryptedFolder; depth: number }[];
}) {
  const selected = useView((store) => store.selected);
  const selectAll = useView((store) => store.selectAll);
  const clear = useView((store) => store.clear);
  const stopSelecting = useView((store) => store.stopSelecting);

  const removeMany = useItems((store) => store.removeMany);
  const restoreMany = useItems((store) => store.restoreMany);
  const moveMany = useItems((store) => store.moveMany);
  const tagMany = useItems((store) => store.tagMany);

  const [tag, setTag] = useState('');

  const ids = [...selected];
  const count = ids.length;

  return (
    <div
      className="border-accent mt-4 flex flex-wrap items-center gap-2 border p-3"
      data-testid="bulk-bar"
    >
      <p className="text-accent mr-auto font-mono text-xs" aria-live="polite">
        <span aria-hidden="true">&gt; </span>
        <span data-testid="bulk-count">{count}</span> selected
      </p>

      <Button
        type="button"
        variant="ghost"
        onClick={() => selectAll(visible.map((item) => item.id))}
        data-testid="bulk-all"
      >
        all
      </Button>
      <Button type="button" variant="ghost" onClick={clear} data-testid="bulk-none">
        none
      </Button>

      {count > 0 ? (
        <>
          <div className="min-w-40">
            <Select
              value=""
              placeholder="move to…"
              aria-label="move to folder"
              data-testid="bulk-move"
              onChange={(folderId) => {
                void moveMany(ids, folderId === UNFILED ? null : folderId);
                toast(`${count} item(s) moved.`);
                clear();
              }}
              options={[
                // Not the empty string: this Select is an action menu held at
                // `value=""` so the trigger keeps reading "move to…". An option
                // valued `''` would match it and the prompt would be replaced
                // by "no folder" before anything had been chosen.
                { value: UNFILED, label: 'no folder' },
                ...folders.map(({ folder, depth }) => ({
                  value: folder.id,
                  label: folder.name,
                  depth,
                  color: folder.color,
                })),
              ]}
            />
          </div>

          <Input
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            placeholder="tag…"
            aria-label="tag the selection"
            data-testid="bulk-tag"
            className="w-32"
          />
          <Button
            type="button"
            variant="ghost"
            disabled={tag.trim() === ''}
            onClick={() => {
              void tagMany(ids, tag);
              toast(`${count} item(s) tagged.`);
              setTag('');
              clear();
            }}
            data-testid="bulk-tag-apply"
          >
            add tag
          </Button>

          <Button
            type="button"
            variant="danger"
            onClick={() => {
              void removeMany(ids);
              toast(`${count} item(s) moved to trash.`, {
                tone: 'warning',
                action: { label: 'undo', run: () => void restoreMany(ids) },
              });
              stopSelecting();
            }}
            data-testid="bulk-delete"
          >
            delete
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The bottom bar, on phones only.
 *
 * A phone holds a thumb at the bottom of the screen and a header at the top,
 * and the vault is one scrolling column between them. Everything here is also
 * reachable from the footer on a wider screen, where a bar fixed to the bottom
 * of a 27-inch display would be absurd.
 *
 * Panic is not in it. A bar is where a thumb rests between taps, which is the
 * worst possible place for a button that destroys the local vault.
 */
function BottomNav({
  view,
  trashed,
  onGo,
  onLock,
}: {
  view: View['kind'];
  trashed: number;
  onGo: (kind: 'list' | 'new' | 'folders' | 'trash') => void;
  onLock: () => void;
}) {
  const tab = (
    kind: 'list' | 'new' | 'folders' | 'trash',
    label: string,
    glyph: string,
    badge?: number,
  ) => (
    <button
      type="button"
      onClick={() => onGo(kind)}
      aria-current={view === kind ? 'page' : undefined}
      data-testid={`nav-${kind}`}
      // 44px minimum, and the label always visible: an icon-only bar in a
      // product people use half-awake is a guessing game.
      className={
        view === kind
          ? 'text-accent text-glow flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[10px] tracking-widest uppercase'
          : 'text-muted flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[10px] tracking-widest uppercase'
      }
    >
      <span aria-hidden="true" className="text-sm">
        {glyph}
      </span>
      {label}
      {badge ? <span className="sr-only">{badge} items</span> : null}
    </button>
  );

  return (
    <nav
      aria-label="vault"
      data-testid="bottom-nav"
      // `pb-[env(safe-area-inset-bottom)]` keeps the labels clear of the iOS
      // home indicator, which otherwise sits directly on top of them.
      className="border-line fixed inset-x-0 bottom-0 z-40 flex border-t bg-black pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      {tab('list', 'vault', '▤')}
      {tab('folders', 'folders', '▸')}
      {tab('new', 'new', '+')}
      {trashed > 0 ? tab('trash', 'trash', '␡', trashed) : null}
      <button
        type="button"
        onClick={onLock}
        data-testid="nav-lock"
        className="text-muted flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[10px] tracking-widest uppercase"
      >
        <span aria-hidden="true" className="text-sm">
          ▪
        </span>
        lock
      </button>
    </nav>
  );
}

/**
 * Pull down to sync.
 *
 * Touch only: a desktop has the connection indicator and a page that refreshes
 * itself, and a mouse has nothing to pull with.
 */
function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pull = usePullToRefresh(onRefresh);

  const label = pull.refreshing ? 'syncing' : pull.armed ? 'release to sync' : 'pull to sync';

  return (
    <div {...pull.handlers} data-testid="pull-to-refresh">
      {pull.distance > 0 || pull.refreshing ? (
        <p
          className="text-accent-dim overflow-hidden text-center font-mono text-xs"
          style={{ height: pull.refreshing ? 24 : pull.distance }}
          aria-live="polite"
          data-testid="pull-indicator"
        >
          <span aria-hidden="true">{pull.refreshing ? '...' : pull.armed ? '^' : 'v'} </span>
          {label}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Folder and tag filters.
 *
 * Chips rather than a sidebar: the vault is one column on a phone and the same
 * one column on a desktop, and a filter that only exists at one width is a
 * filter half the users never find.
 *
 * Nothing renders at all until there is something to filter by. An empty row of
 * controls on a new vault teaches nothing and takes the space the list needs.
 */
function Filters({
  folders,
  tags,
  folderFilter,
  tagFilter,
  onFolder,
  onTag,
  onManage,
}: {
  folders: readonly { folder: DecryptedFolder; depth: number }[];
  tags: readonly string[];
  folderFilter: FolderFilter;
  tagFilter: string | null;
  onFolder: (value: FolderFilter) => void;
  onTag: (value: string | null) => void;
  onManage: () => void;
}) {
  if (folders.length === 0 && tags.length === 0) return null;

  return (
    <div className="mt-4 space-y-2" data-testid="filters">
      {folders.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="folder-filters">
          <Chip active={folderFilter === null} onClick={() => onFolder(null)} testId="folder-all">
            all
          </Chip>
          {folders.map(({ folder, depth }) => (
            <Chip
              key={folder.id}
              active={folderFilter === folder.id}
              onClick={() => onFolder(folderFilter === folder.id ? null : folder.id)}
              testId="folder-chip"
              color={folder.color}
            >
              {depth > 0 ? <span aria-hidden="true">└ </span> : null}
              {folder.name}
            </Chip>
          ))}
          <Chip
            active={folderFilter === 'none'}
            onClick={() => onFolder(folderFilter === 'none' ? null : 'none')}
            testId="folder-none"
          >
            unfiled
          </Chip>
          <button
            type="button"
            onClick={onManage}
            className="text-muted hover:text-accent font-mono text-xs underline-offset-4 hover:underline"
            data-testid="manage-folders"
          >
            manage
          </button>
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="tag-filters">
          {tags.map((tag) => (
            <Chip
              key={tag}
              active={tagFilter === tag}
              onClick={() => onTag(tagFilter === tag ? null : tag)}
              testId="tag-chip"
            >
              #{tag}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  testId,
  color,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
  color?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={
        active
          ? 'border-accent text-accent shadow-glow-soft border px-2 py-1 font-mono text-xs'
          : 'border-line text-muted hover:border-accent hover:text-accent border px-2 py-1 font-mono text-xs'
      }
    >
      {color ? (
        <span
          aria-hidden="true"
          className="mr-1 inline-block h-2 w-2 align-middle"
          style={{ backgroundColor: color }}
        />
      ) : null}
      {children}
    </button>
  );
}

/**
 * Managing folders.
 *
 * Deleting one says how many items are inside, because the answer changes what
 * a person does next — and then keeps them anyway, moving them out rather than
 * down with the folder.
 */
function Folders({
  folders,
  items,
  onBack,
}: {
  folders: readonly { folder: DecryptedFolder; depth: number }[];
  items: readonly DecryptedItem[];
  onBack: () => void;
}) {
  const saveFolder = useItems((store) => store.saveFolder);
  const removeFolder = useItems((store) => store.removeFolder);

  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [color, setColor] = useState<string>(FOLDER_COLORS[0]);

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const item of items) {
      if (item.folderId === null) continue;
      tally.set(item.folderId, (tally.get(item.folderId) ?? 0) + 1);
    }
    return tally;
  }, [items]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (name.trim() === '') return;

    await saveFolder(name.trim(), { parentId, color });
    setName('');
    setParentId(null);
  }

  return (
    <Panel className="mt-6">
      <h2 className="text-accent typewriter mb-6 font-mono text-sm tracking-widest uppercase">
        folders
      </h2>

      <form onSubmit={(event) => void create(event)} className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="folder name"
          aria-label="folder name"
          autoComplete="off"
          data-testid="folder-name"
          className="min-w-0 flex-1"
        />
        <div className="min-w-40 flex-1">
          <Select
            value={parentId ?? ''}
            onChange={(next) => setParentId(next || null)}
            aria-label="parent folder"
            data-testid="folder-parent"
            options={[
              { value: '', label: 'top level' },
              ...folders.map(({ folder, depth }) => ({
                value: folder.id,
                label: folder.name,
                depth,
                color: folder.color,
              })),
            ]}
          />
        </div>
        <Button type="submit" disabled={name.trim() === ''} data-testid="folder-create">
          create
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="folder colour">
        {FOLDER_COLORS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setColor(option)}
            aria-pressed={color === option}
            aria-label={`colour ${option}`}
            data-testid="folder-color"
            className={
              color === option
                ? 'border-accent shadow-glow-soft h-6 w-6 border-2'
                : 'border-line h-6 w-6 border'
            }
            style={{ backgroundColor: option }}
          />
        ))}
      </div>

      {folders.length === 0 ? (
        <p className="text-muted mt-8 font-mono text-sm" data-testid="folders-empty">
          <span aria-hidden="true">&gt; </span>
          no folders yet
        </p>
      ) : (
        <ul className="border-line mt-8 border-t" data-testid="folder-list">
          {folders.map(({ folder, depth }) => (
            <li
              key={folder.id}
              className="border-line flex items-center justify-between gap-3 border-b py-3"
              data-testid="folder-row"
            >
              <span
                className="text-fg flex min-w-0 items-center gap-2 truncate font-mono text-sm"
                style={{ paddingLeft: `${depth * 16}px` }}
              >
                {folder.color ? (
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0"
                    style={{ backgroundColor: folder.color }}
                  />
                ) : null}
                {folder.name}
                <span className="text-muted text-xs">({counts.get(folder.id) ?? 0})</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void removeFolder(folder.id)}
                aria-label={`delete folder ${folder.name}`}
                data-testid="folder-delete"
              >
                delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted mt-6 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        Deleting a folder keeps everything inside it. The items move out, not away.
      </p>

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-6"
        data-testid="folders-back"
      >
        back
      </Button>
    </Panel>
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
  layout,
  selecting,
  onEdit,
}: {
  items: readonly DecryptedItem[];
  loading: boolean;
  query: string;
  layout: Layout;
  selecting: boolean;
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
    <ul
      className={layout === 'grid' ? 'mt-6 grid gap-3 sm:grid-cols-2' : 'border-line mt-6 border-t'}
      data-layout={layout}
      data-testid="item-list"
    >
      {items.map((item) => (
        <ItemRow key={item.id} item={item} layout={layout} selecting={selecting} onEdit={onEdit} />
      ))}
    </ul>
  );
}

function ItemRow({
  item,
  layout,
  selecting,
  onEdit,
}: {
  item: DecryptedItem;
  layout: Layout;
  selecting: boolean;
  onEdit: (id: string) => void;
}) {
  const [copied, setCopied] = useState<'username' | 'password' | null>(null);

  const markUsed = useItems((store) => store.markUsed);
  const setFavorite = useItems((store) => store.setFavorite);
  const remove = useItems((store) => store.remove);
  const restore = useItems((store) => store.restore);

  const [historyOpen, setHistoryOpen] = useState(false);

  const selected = useView((store) => store.selected.has(item.id));
  const toggleSelected = useView((store) => store.toggle);

  const fields = item.data.type === 'login' ? item.data.fields : null;

  async function copy(which: 'username' | 'password', value: string | undefined) {
    if (!value) return;

    const ok = await copySecret(value);

    if (!ok) {
      toast('The browser refused clipboard access. Reveal the value and copy it by hand.', {
        tone: 'danger',
      });
      return;
    }

    pulse();
    setCopied(which);
    void markUsed(item.id);

    // Never the value itself — a toast lingers, unprompted, in exactly the
    // frame a screen recording captures.
    toast(`${which} copied. The clipboard clears in 30 seconds.`);

    setTimeout(() => setCopied(null), 2000);
  }

  // Left copies the password, right copies the username — the same two actions
  // as the buttons, reachable with one thumb. Rows with nothing to copy do not
  // move at all, rather than sliding to reveal an action that does nothing.
  // Off while selecting. A thumb reaching for a checkbox that instead put a
  // password on the clipboard would be the worst kind of surprise.
  const swipe = useSwipe({
    ...(fields?.password && !selecting
      ? { onSwipeLeft: () => void copy('password', fields.password) }
      : {}),
    ...(fields?.username && !selecting
      ? { onSwipeRight: () => void copy('username', fields.username) }
      : {}),
  });

  return (
    <li
      className={
        layout === 'grid'
          ? 'border-line relative overflow-hidden border p-4'
          : 'border-line relative overflow-hidden border-b py-4'
      }
      data-testid="item-row"
      {...swipe.handlers}
    >
      {swipe.offset !== 0 ? (
        <p
          className={
            swipe.armed
              ? 'text-accent text-glow pointer-events-none absolute inset-y-0 flex items-center font-mono text-xs'
              : 'text-muted pointer-events-none absolute inset-y-0 flex items-center font-mono text-xs'
          }
          style={swipe.offset < 0 ? { right: 0 } : { left: 0 }}
          aria-hidden="true"
          data-testid="swipe-hint"
        >
          {swipe.offset < 0 ? 'copy password' : 'copy username'}
        </p>
      ) : null}

      <div
        className={
          layout === 'grid' ? 'flex flex-col gap-3' : 'flex items-start justify-between gap-3'
        }
        style={
          swipe.offset === 0
            ? undefined
            : { transform: `translateX(${swipe.offset}px)`, willChange: 'transform' }
        }
      >
        <div className="flex min-w-0 items-start gap-3">
          {selecting ? (
            <Checkbox
              checked={selected}
              onChange={() => toggleSelected(item.id)}
              aria-label={`select ${item.data.fields.title}`}
              data-testid="select-item"
              label=""
              className="shrink-0"
            />
          ) : null}
          <div className="min-w-0">
            <p className="text-fg secret truncate font-mono text-sm" data-testid="item-row-title">
              {item.favorite ? <span aria-label="favourite">★ </span> : null}
              {item.data.fields.title}
            </p>
            {item.data.type !== 'login' ? (
              <p className="text-accent-dim font-mono text-[10px] tracking-widest uppercase">
                {item.data.type}
              </p>
            ) : null}
            <p className="text-muted secret truncate font-mono text-xs">
              {itemSubtitle(item.data)}
            </p>
            {item.data.fields.tags?.length ? (
              <p
                className="text-accent-dim secret mt-1 truncate font-mono text-[10px]"
                data-testid="item-row-tags"
              >
                {item.data.fields.tags.map((tag) => `#${tag}`).join(' ')}
              </p>
            ) : null}
          </div>
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
            onClick={() => setHistoryOpen((current) => !current)}
            aria-pressed={historyOpen}
            data-testid="item-history"
          >
            history
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void remove(item.id);
              toast('Moved to trash.', {
                tone: 'warning',
                action: { label: 'undo', run: () => void restore(item.id) },
              });
            }}
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
          <p className="text-fg secret mt-2 max-h-64 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {item.data.fields.body}
          </p>
        </details>
      ) : null}

      {fields?.totpSecret ? (
        <div className="mt-3" data-testid="item-totp-row">
          <TotpCode secret={fields.totpSecret} />
        </div>
      ) : null}

      {item.data.fields.linkedProjectId ? (
        <LinkedProject projectId={item.data.fields.linkedProjectId} />
      ) : null}

      {historyOpen ? <ItemHistory item={item} /> : null}

      {fields?.password ? (
        <p className="text-muted mt-2 font-mono text-[10px]" data-testid="item-password-age">
          <span aria-hidden="true">&gt; </span>
          {describePasswordAge(passwordAgeDays(fields)) ?? 'age unknown'}
        </p>
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

      {/*
        Both of these used to be printed under the row. The toast says the same
        thing once, in one place, rather than the list growing a paragraph
        under whichever row was last touched.
      */}
    </li>
  );
}

/**
 * Importing a CSV from another password manager.
 *
 * The mapping is shown and can be changed before anything is stored, because
 * the guess is a guess. Getting `username` and `email` the wrong way round is
 * the kind of mistake that is invisible afterwards and annoying for years, and
 * the moment to catch it is while the file is still on screen.
 *
 * Everything here happens in the tab. The file is a plaintext export of
 * somebody's entire vault, and the one thing it must never do is take a trip
 * through a server — including this one.
 */
const IMPORT_FIELDS: { field: ImportField; label: string }[] = [
  { field: 'title', label: 'title' },
  { field: 'username', label: 'username' },
  { field: 'password', label: 'password' },
  { field: 'url', label: 'url' },
  { field: 'notes', label: 'notes' },
  { field: 'totp', label: 'one-time code' },
];

function ImportPanel({ onBack }: { onBack: () => void }) {
  const save = useItems((store) => store.save);

  const [rows, setRows] = useState<readonly (readonly string[])[] | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const header = rows?.[0] ?? [];
  const body = useMemo(() => (rows ? rows.slice(1) : []), [rows]);
  const preview = useMemo(() => rowsToItems(body, mapping), [body, mapping]);

  async function run(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      for (const entry of preview.items) {
        await save({
          type: 'login',
          fields: {
            title: entry.title,
            ...(entry.username ? { username: entry.username } : {}),
            ...(entry.password ? { password: entry.password } : {}),
            ...(entry.url ? { url: entry.url } : {}),
            ...(entry.notes ? { notes: entry.notes } : {}),
            ...(entry.totp ? { totpSecret: entry.totp } : {}),
            // Stamped now rather than left unknown: these passwords were set
            // somewhere else, and the file does not say when.
            passwordChangedAt: Date.now(),
          },
        });
      }

      toast(
        preview.skipped > 0
          ? `Imported ${preview.items.length}; skipped ${preview.skipped} empty row(s).`
          : `Imported ${preview.items.length} item(s).`,
      );
      onBack();
    } catch {
      setError('Something went wrong partway through. What was imported is already saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="mt-6">
      <h2 className="text-accent typewriter mb-6 font-mono text-sm tracking-widest uppercase">
        import
      </h2>

      <Warning title="an export is a plaintext copy of your vault">
        Whatever you exported from is now sitting unencrypted on your disk. Delete it once this is
        done — that file needs no password at all.
      </Warning>

      <div className="mt-6">
        <label className={BUTTON_LIKE}>
          choose a .csv
          <input
            type="file"
            accept="text/csv,.csv"
            className="sr-only"
            data-testid="import-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;

              void file.text().then((text) => {
                const parsed = parseCsv(text);
                setRows(parsed);
                setMapping(detectColumns(parsed[0] ?? []));
              });
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {rows !== null ? (
        rows.length < 2 ? (
          <p className="text-warning mt-4 font-mono text-xs" data-testid="import-empty">
            <span aria-hidden="true">! </span>
            That file has a header and no rows.
          </p>
        ) : (
          <>
            <p className="text-muted mt-6 font-mono text-xs" data-testid="import-summary">
              <span aria-hidden="true">&gt; </span>
              {body.length} row(s). Check the columns below before importing.
            </p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="import-mapping">
              {IMPORT_FIELDS.map(({ field, label }) => (
                <label key={field} className="block">
                  <span className="text-muted mb-1 block font-mono text-xs tracking-widest uppercase">
                    {label}
                  </span>
                  <Select
                    value={mapping[field] === undefined ? '' : String(mapping[field])}
                    onChange={(next) =>
                      setMapping((current) => {
                        const updated = { ...current };
                        if (next === '') delete updated[field];
                        else updated[field] = Number(next);
                        return updated;
                      })
                    }
                    aria-label={`column for ${label}`}
                    data-testid={`import-map-${field}`}
                    options={[
                      { value: '', label: 'not imported' },
                      ...header.map((name, index) => ({
                        value: String(index),
                        label: name || `column ${index + 1}`,
                      })),
                    ]}
                  />
                </label>
              ))}
            </div>

            {preview.items[0] ? (
              <p className="text-muted secret mt-4 font-mono text-xs" data-testid="import-preview">
                <span aria-hidden="true">&gt; </span>
                First row reads as: {preview.items[0].title}
                {preview.items[0].username ? ` · ${preview.items[0].username}` : ''}
                {preview.items[0].password ? ' · password set' : ' · no password'}
              </p>
            ) : null}

            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                type="button"
                disabled={busy || !mappingIsUsable(mapping) || preview.items.length === 0}
                onClick={() => void run()}
                data-testid="import-run"
              >
                {busy ? '... importing' : `import ${preview.items.length} item(s)`}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRows(null)}>
                choose another file
              </Button>
            </div>
          </>
        )
      ) : null}

      {error ? (
        <p role="alert" className="text-danger mt-4 font-mono text-xs" data-testid="import-error">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-6"
        data-testid="import-back"
      >
        back
      </Button>
    </Panel>
  );
}

/**
 * Changing the master password.
 *
 * From the outside this is the smallest operation in the product: the vault is
 * encrypted under the Account Key, which does not change, and only the
 * thirty-two-byte wrapper around it is replaced. Ten thousand items cost the
 * same as none.
 *
 * The current password is asked for even though the vault is open. A session
 * proves a browser was left unlocked; it does not prove the person at the
 * keyboard knows the password, and this is exactly what somebody who found an
 * unlocked laptop would reach for.
 */
function PasswordPanel({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const lock = useVault((vault) => vault.lock);

  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const mismatch = confirm !== '' && next !== confirm;
  const ready = email !== '' && currentPassword !== '' && next !== '' && next === confirm;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || busy) return;

    setBusy(true);
    setError('');
    try {
      await changeMasterPassword(email, currentPassword, next, setProgress);

      // Every session was revoked, including this one, so the only honest thing
      // to do is send them back to unlock with the new password.
      lock(false);
      router.push('/login');
    } catch (cause) {
      setError(
        cause instanceof PasswordChangeRejected
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Could not change the password.',
      );
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  return (
    <Panel className="mt-6">
      <h2 className="text-accent typewriter mb-6 font-mono text-sm tracking-widest uppercase">
        change master password
      </h2>

      <Warning title="everything else stays where it is">
        Your items are not re-encrypted and nothing is re-uploaded — only the key that opens them is
        re-wrapped. Every other session is signed out, including on your other devices.
      </Warning>

      <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4" noValidate>
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="your email"
          aria-label="email"
          autoComplete="username"
          data-testid="password-email"
        />
        <Input
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          placeholder="current master password"
          aria-label="current master password"
          autoComplete="current-password"
          data-testid="password-current"
        />
        <Input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder="new master password"
          aria-label="new master password"
          autoComplete="new-password"
          data-testid="password-new"
        />
        <Input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder="confirm new master password"
          aria-label="confirm new master password"
          autoComplete="new-password"
          invalid={mismatch}
          data-testid="password-confirm"
        />

        {mismatch ? (
          <p className="text-danger font-mono text-xs" data-testid="password-mismatch">
            <span aria-hidden="true">! </span>
            Those two do not match.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!ready || busy} data-testid="password-save">
            {busy ? `... ${progress || 'working'}` : 'change it'}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack} data-testid="password-back">
            cancel
          </Button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="text-danger mt-4 font-mono text-xs" data-testid="password-error">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Taking a backup, and putting one back.
 *
 * The warning is not decoration. A backup file is offline-attackable: whoever
 * takes it can guess master passwords against it at their own pace, with no
 * rate limit and no server involved. That is inherent to any backup worth
 * having — one that needs the running service to read is not a backup of
 * anything — and the honest thing is to say so at the moment somebody
 * downloads the file, not in a document they will never open.
 */
function BackupPanel({ onBack }: { onBack: () => void }) {
  const keys = useVault((vault) => vault.keys);
  const load = useItems((store) => store.load);
  const items = useItems((store) => store.items);
  const folders = useItems((store) => store.folders);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ text: string; password: string } | null>(null);

  async function download(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const backup = await buildBackup();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
      );

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = backupFilename(backup.createdAt);
      anchor.click();
      URL.revokeObjectURL(url);

      toast('Backup downloaded. It is worth what your master password is worth.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build a backup.');
    } finally {
      setBusy(false);
    }
  }

  async function restore(text: string, password: string): Promise<void> {
    if (!keys) return;

    setBusy(true);
    setError('');
    try {
      const parsed = readBackup(text);
      if ('error' in parsed) {
        setError(parsed.error);
        return;
      }

      // Which ids this account already has, so a same-account restore updates
      // in place and a cross-account one is renumbered.
      const known = new Set<string>([
        ...items.map((entry) => entry.id),
        ...folders.map((entry) => entry.id),
      ]);

      const result = await restoreBackup(parsed.backup, password, keys, known);
      await load();

      toast(
        result.unreadable > 0
          ? `Restored ${result.items} item(s); ${result.unreadable} could not be opened.`
          : `Restored ${result.items} item(s) and ${result.vars} variable(s).`,
        result.unreadable > 0 ? { tone: 'warning' } : {},
      );
      setPending(null);
      onBack();
    } catch (cause) {
      setError(
        cause instanceof BackupPasswordWrong
          ? cause.message
          : 'Could not restore that backup. Nothing has been changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="mt-6">
      <h2 className="text-accent typewriter mb-6 font-mono text-sm tracking-widest uppercase">
        backup
      </h2>

      <Warning title="a backup is worth your master password">
        The file holds everything, still encrypted, plus what is needed to derive the key. Anyone
        who takes it can try passwords against it offline, at their own pace. Keep it where you
        would keep the Emergency Kit.
      </Warning>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          data-testid="backup-download"
        >
          {busy ? '... working' : 'download a backup'}
        </Button>

        <label className={BUTTON_LIKE}>
          restore from a file
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            data-testid="backup-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file.text().then((text) => setPending({ text, password: '' }));
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {pending ? (
        <div className="border-line mt-6 border-t pt-6">
          <p className="text-muted mb-3 font-mono text-xs" data-testid="backup-summary">
            <span aria-hidden="true">&gt; </span>
            {describeFile(pending.text)}
          </p>
          <p className="text-muted mb-3 font-mono text-xs">
            <span aria-hidden="true">&gt; </span>
            Nothing is removed. What the file does not mention is left alone.
          </p>

          <Input
            type="password"
            value={pending.password}
            onChange={(event) => setPending({ ...pending, password: event.target.value })}
            placeholder="the master password the backup was made under"
            aria-label="backup master password"
            autoComplete="off"
            data-testid="backup-password"
          />

          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              type="button"
              disabled={busy || pending.password === ''}
              onClick={() => void restore(pending.text, pending.password)}
              data-testid="backup-restore"
            >
              {busy ? '... restoring' : 'restore'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>
              cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-danger mt-4 font-mono text-xs" data-testid="backup-error">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="mt-6"
        data-testid="backup-back"
      >
        back
      </Button>
    </Panel>
  );
}

/** What a chosen file turns out to be, before anything is done with it. */
function describeFile(text: string): string {
  const parsed = readBackup(text);
  if ('error' in parsed) return parsed.error;

  const counts = backupContents(parsed.backup);
  const taken = new Date(parsed.backup.createdAt).toLocaleString();

  return `A ${BACKUP_FORMAT} backup from ${taken}: ${counts.items} item(s), ${counts.folders} folder(s), ${counts.projects} project(s), ${counts.vars} variable(s).`;
}

/** A file input cannot be a Button, so the label borrows its look. */
const BUTTON_LIKE =
  'border-line text-muted hover:border-fg hover:text-fg inline-flex min-h-11 cursor-pointer items-center justify-center border px-4 py-2 font-mono text-sm tracking-tight';

/**
 * The project this credential belongs with.
 *
 * The environment data is only loaded when something on screen actually links
 * to it, so a vault with no links never asks for it — and a vault that does
 * asks once.
 *
 * If the project is not there, the row says the link is broken rather than
 * disappearing. A link that silently vanishes when a project is deleted looks
 * like the item was edited by somebody else.
 */
function LinkedProject({ projectId }: { projectId: string }) {
  const router = useRouter();

  const projects = useEnv((store) => store.projects);
  const loadEnv = useEnv((store) => store.load);

  useEffect(() => {
    if (projects.length === 0) void loadEnv();
  }, [projects.length, loadEnv]);

  const project = activeProjects(projects).find((entry) => entry.id === projectId);

  return (
    <p className="text-accent-dim mt-2 font-mono text-[10px]" data-testid="item-linked-project">
      <span aria-hidden="true">&gt; </span>
      {project ? (
        <button
          type="button"
          onClick={() => router.push(`/env?project=${projectId}`)}
          data-testid="item-linked-open"
          className="secret hover:text-accent underline underline-offset-4"
        >
          {project.name}
        </button>
      ) : (
        <span className="text-muted">linked project not found</span>
      )}
    </p>
  );
}

/**
 * What an item used to be.
 *
 * Titles and the same subtitle line the list shows — never a stored value. A
 * history panel that printed old passwords would be a list of every password
 * somebody has ever used, sitting open on the screen, which is a worse thing to
 * leave lying around than the current one.
 *
 * Restoring is an ordinary save, so the version it replaces is recorded in turn
 * and going back is undoable.
 */
function ItemHistory({ item }: { item: DecryptedItem }) {
  const keys = useVault((vault) => vault.keys);
  const recent = useItems((store) => store.recentVersions[item.id]);
  const save = useItems((store) => store.save);

  const [versions, setVersions] = useState<ItemVersion[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!keys) return;

    let cancelled = false;
    void fetchItemHistory(keys, item.id)
      .then((result) => {
        if (!cancelled) setVersions(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
    // `updatedAt` so a save re-asks, and a redraw for any other reason does not.
  }, [keys, item.id, item.updatedAt]);

  // What the server returned plus what this session wrote, since a read
  // straight after a write does not reliably include it.
  const merged = [...(recent ?? []), ...(versions ?? [])].filter(
    (entry, index, all) =>
      all.findIndex((other) => JSON.stringify(other.data) === JSON.stringify(entry.data)) === index,
  );

  if (failed) {
    return (
      <p className="text-warning mt-3 font-mono text-xs" data-testid="item-history-error">
        <span aria-hidden="true">! </span>
        Could not load the history.
      </p>
    );
  }

  if (versions === null && merged.length === 0) {
    return (
      <p className="text-muted mt-3 font-mono text-xs">
        <span aria-hidden="true">&gt; </span>
        loading...
      </p>
    );
  }

  if (merged.length === 0) {
    return (
      <p className="text-muted mt-3 font-mono text-xs" data-testid="item-history-empty">
        <span aria-hidden="true">&gt; </span>
        no earlier versions
      </p>
    );
  }

  return (
    <ol className="border-line mt-3 space-y-2 border-l pl-3" data-testid="item-history-list">
      {merged.map((version) => (
        <li
          key={version.id}
          className="flex flex-wrap items-center gap-2"
          data-testid="item-version"
        >
          <span className="text-muted font-mono text-[10px]">
            <span aria-hidden="true">&gt; </span>
            {new Date(version.createdAt).toLocaleString()}
          </span>
          <span className="text-fg secret truncate font-mono text-[11px]">
            {version.data.fields.title}
          </span>
          <span className="text-muted secret truncate font-mono text-[10px]">
            {itemSubtitle(version.data)}
          </span>
          <button
            type="button"
            onClick={() => {
              void save(version.data, item.id);
              toast('Restored an earlier version.', { tone: 'warning' });
            }}
            data-testid="item-version-restore"
            className="text-accent-dim hover:text-accent ml-auto font-mono text-[10px] tracking-widest uppercase underline underline-offset-4"
          >
            restore
          </button>
        </li>
      ))}
    </ol>
  );
}

function Trash({ items, onBack }: { items: readonly DecryptedItem[]; onBack: () => void }) {
  const restore = useItems((store) => store.restore);

  return (
    <Panel className="mt-6">
      <h2 className="text-accent typewriter mb-2 font-mono text-sm tracking-widest uppercase">
        trash
      </h2>
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
