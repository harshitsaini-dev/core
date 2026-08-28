'use client';

import {
  FOLDER_COLORS,
  collectTags,
  describePasswordAge,
  itemSubtitle,
  orderFolders,
  passwordAgeDays,
} from '@core/shared';
import type { DecryptedFolder, DecryptedItem } from '@core/shared';
import type { Layout } from '@/lib/client/view-store';
import { Button, Checkbox, Input, Panel, Select } from '@core/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearClipboardNow, copySecret, pulse } from '@/lib/client/clipboard';
import { usePullToRefresh, useSwipe } from '@/lib/client/gestures';
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
  | { kind: 'folders' };

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
