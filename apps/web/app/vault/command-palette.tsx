'use client';

import { itemSubtitle } from '@core/shared';
import type { DecryptedItem } from '@core/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { search } from '@/lib/client/search';

/**
 * The command palette.
 *
 * One field that reaches everything: the items, and the handful of actions the
 * vault has. It exists because the fastest possible path to a password is
 * Ctrl+K, three letters, Enter — and because a keyboard-only path matters more
 * here than in most products, where a mouse is not being watched over a
 * shoulder.
 *
 * Two rules it does not break:
 *
 *   1. **It shows titles, never values.** The subtitle line is the same one the
 *      list shows, which already excludes passwords. A palette that revealed
 *      secrets as you typed would be a filter somebody could read from across
 *      the room.
 *
 *   2. **Nothing destructive is one Enter away.** Delete and panic are absent
 *      deliberately. Fuzzy matching plus a reflexive Return is exactly how an
 *      irreversible action gets triggered by accident, and this product has no
 *      password reset to fall back on.
 */

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

type Row =
  { kind: 'command'; command: Command } | { kind: 'item'; item: DecryptedItem; onOpen: () => void };

export function CommandPalette({
  items,
  commands,
  onClose,
  onOpenItem,
}: {
  items: readonly DecryptedItem[];
  commands: readonly Command[];
  onClose: () => void;
  onOpenItem: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const rows = useMemo<Row[]>(() => {
    const trimmed = query.trim();

    const matchedCommands = commands.filter((command) =>
      trimmed === '' ? true : command.label.toLowerCase().includes(trimmed.toLowerCase()),
    );

    // The item list is capped. Beyond a screenful the palette stops being a
    // shortcut and becomes a second, worse vault list — and rendering a
    // thousand rows on every keystroke is what makes palettes feel slow.
    const matchedItems = (
      trimmed === '' ? items.slice(0, 8) : search(items, trimmed).map((result) => result.item)
    ).slice(0, 8);

    return [
      ...matchedCommands.map((command) => ({ kind: 'command', command }) as const),
      ...matchedItems.map(
        (item) => ({ kind: 'item', item, onOpen: () => onOpenItem(item.id) }) as const,
      ),
    ];
  }, [query, items, commands, onOpenItem]);

  // A stale index would run whichever row happened to slide into that position.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the highlighted row on screen when it is reached by keyboard rather
  // than by pointer.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose(row: Row | undefined): void {
    if (!row) return;
    if (row.kind === 'command') row.command.run();
    else row.onOpen();
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActive((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length));
      return;
    }

    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive((current) => (rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[active]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/80 px-4 pt-[10vh]"
      // Clicking away closes it, which is what every palette does and what a
      // hand reaching for the mouse expects.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-testid="palette-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="command palette"
        className="border-line shadow-glow-soft w-full max-w-xl border bg-black"
        onKeyDown={onKeyDown}
        data-testid="palette"
      >
        <div className="border-line flex items-center gap-2 border-b px-3 py-2">
          <span className="text-accent font-mono text-sm" aria-hidden="true">
            &gt;
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search or run a command"
            aria-label="command"
            aria-controls="palette-results"
            aria-activedescendant={rows[active] ? `palette-row-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            data-testid="palette-input"
            className="text-fg placeholder:text-muted/60 w-full bg-black py-1 font-mono text-base focus:outline-none sm:text-sm"
          />
        </div>

        {rows.length === 0 ? (
          <p className="text-muted px-3 py-6 font-mono text-xs" data-testid="palette-empty">
            <span aria-hidden="true">&gt; </span>
            no match for &quot;{query}&quot;
          </p>
        ) : (
          <ul
            ref={listRef}
            id="palette-results"
            role="listbox"
            aria-label="results"
            className="max-h-[50vh] overflow-auto"
            data-testid="palette-results"
          >
            {rows.map((row, index) => (
              <li
                key={row.kind === 'command' ? row.command.id : row.item.id}
                id={`palette-row-${index}`}
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                data-testid={row.kind === 'command' ? 'palette-command' : 'palette-item'}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(row)}
                className={
                  index === active
                    ? 'text-accent border-accent flex cursor-pointer items-center justify-between gap-3 border-l-2 px-3 py-2 font-mono text-sm'
                    : 'text-muted flex cursor-pointer items-center justify-between gap-3 border-l-2 border-transparent px-3 py-2 font-mono text-sm'
                }
              >
                {row.kind === 'command' ? (
                  <>
                    <span className="truncate">{row.command.label}</span>
                    {row.command.hint ? (
                      <span className="text-muted shrink-0 text-[10px] tracking-widest uppercase">
                        {row.command.hint}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="truncate" data-testid="palette-item-title">
                      {row.item.data.fields.title}
                    </span>
                    <span className="text-muted shrink-0 truncate text-xs">
                      {itemSubtitle(row.item.data)}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="border-line text-muted border-t px-3 py-2 font-mono text-[10px]">
          <span aria-hidden="true">↑↓</span> move · <span aria-hidden="true">↵</span> open ·
          <span aria-hidden="true"> esc</span> close
        </p>
      </div>
    </div>
  );
}
