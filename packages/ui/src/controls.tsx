'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';

/**
 * Form controls, drawn by us rather than by the operating system.
 *
 * Native checkboxes, radios and dropdowns are painted by the platform. On this
 * interface — pure black, one hue, square corners — they arrive as rounded blue
 * Windows widgets and white dropdown menus, and no amount of surrounding
 * styling hides that.
 *
 * Two different problems, solved two different ways:
 *
 *   - **Checkbox and radio** keep the native input. `appearance: none` removes
 *     the platform drawing and leaves a real, focusable, labellable control
 *     that screen readers and `.check()` already understand. Only the paint is
 *     ours.
 *
 *   - **The dropdown cannot be done that way.** A `<select>`'s popup is drawn
 *     by the OS and is not reachable from CSS at all, so this one is rebuilt as
 *     a listbox: a button, a panel, and the keyboard behaviour a select has.
 *     That is a real cost — the native control is free, tested by the platform,
 *     and behaves correctly on every device. It is spent here only because the
 *     alternative is a white menu in the middle of a black terminal.
 */

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Checkbox and radio
// ---------------------------------------------------------------------------

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Sits to the right of the box, and is what a click targets. */
  label: ReactNode;
  ref?: Ref<HTMLInputElement> | undefined;
}

function Toggle({
  kind,
  label,
  className,
  ...props
}: ToggleProps & { kind: 'checkbox' | 'radio' }) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 font-mono text-xs',
        // Disabled has to be visible without colour: the palette is one hue.
        props.disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        {...props}
        type={kind}
        // `control-toggle` carries the paint; see globals.css. The mark itself
        // is a pseudo-element, so there is no second node to keep in sync with
        // the input's state.
        className={cx('control-toggle', kind === 'radio' && 'control-toggle-radio')}
      />
      <span className="text-fg">{label}</span>
    </label>
  );
}

/** A checkbox. Square, like everything else here. */
export function Checkbox(props: ToggleProps) {
  return <Toggle kind="checkbox" {...props} />;
}

/**
 * A radio.
 *
 * Also square — the zero-radius rule does not get an exception, and roundness
 * is not what distinguishes the two anyway. The mark does: a checkbox fills,
 * a radio shows a dot.
 */
export function Radio(props: ToggleProps) {
  return <Toggle kind="radio" {...props} />;
}

/** A group of radios that share a name, so only one can be chosen. */
export function RadioGroup({
  name,
  value,
  onChange,
  options,
  legend,
  disabled,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: ReactNode }[];
  legend?: string | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <fieldset className="space-y-3">
      {legend ? (
        <legend className="text-muted font-mono text-xs tracking-widest uppercase">{legend}</legend>
      ) : null}
      {options.map((option) => (
        <Radio
          key={option.value}
          name={name}
          value={option.value}
          checked={value === option.value}
          onChange={() => onChange(option.value)}
          label={option.label}
          {...(disabled === undefined ? {} : { disabled })}
        />
      ))}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement> | undefined;
}

/** The multi-line twin of `Input`, so the two cannot drift apart. */
export function Textarea({ invalid, className, ...props }: TextareaProps) {
  return (
    <textarea
      {...props}
      aria-invalid={invalid || undefined}
      className={cx(
        'text-fg w-full border bg-black px-3 py-2 font-mono text-base sm:text-sm',
        'placeholder:text-muted/60',
        'focus:border-accent focus:shadow-glow-soft focus:outline-none',
        invalid ? 'border-danger' : 'border-line',
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** Rendered as indentation. Used for nested folders. */
  readonly depth?: number;
  /** A swatch before the label. */
  readonly color?: string | null;
}

export interface SelectProps {
  readonly id?: string | undefined;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly 'data-testid'?: string | undefined;
}

/**
 * A dropdown.
 *
 * Rebuilt rather than restyled, because a native popup cannot be styled. What
 * that costs is everything the platform gave for free, so the behaviour it
 * replaces is implemented rather than approximated: arrow keys move, Home and
 * End jump, Enter and Space commit, Escape cancels, Tab away closes, and typing
 * a letter jumps to the next option starting with it.
 */
export function Select({
  id,
  value,
  options,
  onChange,
  placeholder = 'select',
  disabled,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: SelectProps) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = options.findIndex((option) => option.value === value);
  const current = selected === -1 ? undefined : options[selected];

  // Open on the current value, not on the top. A list of thirty folders that
  // always opens at the first one makes the chosen one hard to find.
  useEffect(() => {
    if (open) setActive(selected === -1 ? 0 : selected);
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const commit = (index: number): void => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
  };

  const typeAhead = useRef({ buffer: '', at: 0 });

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (disabled) return;

    if (event.key === 'Escape') {
      if (open) event.preventDefault();
      setOpen(false);
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }

    if (!open && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) {
      event.preventDefault();
      setOpen(true);
      return;
    }

    if (!open) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(active);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(options.length - 1, index + 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setActive(options.length - 1);
      return;
    }

    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Type-ahead. Keystrokes within a second accumulate, so "wo" finds "Work"
      // rather than jumping to the first W and then the first O.
      const now = Date.now();
      const state = typeAhead.current;
      state.buffer = now - state.at > 1000 ? event.key : state.buffer + event.key;
      state.at = now;

      const needle = state.buffer.toLowerCase();
      const found = options.findIndex((option) => option.label.toLowerCase().startsWith(needle));
      if (found !== -1) setActive(found);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        data-testid={testId}
        className={cx(
          'text-fg flex min-h-11 w-full items-center justify-between gap-2 border bg-black px-3 py-2 text-left font-mono text-base sm:text-sm',
          'focus:border-accent focus:shadow-glow-soft focus:outline-none',
          open ? 'border-accent' : 'border-line',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {current?.color ? (
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0"
              style={{ backgroundColor: current.color }}
            />
          ) : null}
          <span className={cx('truncate', !current && 'text-muted')}>
            {current?.label ?? placeholder}
          </span>
        </span>
        <span aria-hidden="true" className="text-accent-dim shrink-0 text-xs">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${active}`}
          data-testid={testId ? `${testId}-list` : undefined}
          className="border-accent shadow-glow-soft absolute z-50 mt-1 max-h-64 w-full overflow-auto border bg-black"
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-testid={testId ? `${testId}-option` : undefined}
              data-active={index === active}
              onMouseMove={() => setActive(index)}
              // `mousedown`, not `click`: the outside-click handler runs on
              // mousedown, and a click listener here would fire after the panel
              // had already been told to close.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(index);
              }}
              className={cx(
                'flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 font-mono text-sm',
                index === active
                  ? 'text-accent border-accent border-l-2'
                  : 'text-muted border-l-2 border-transparent',
              )}
              style={{ paddingLeft: `${12 + (option.depth ?? 0) * 14}px` }}
            >
              {option.color ? (
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 shrink-0"
                  style={{ backgroundColor: option.color }}
                />
              ) : null}
              <span className="truncate">{option.label}</span>
              {option.value === value ? (
                <span aria-hidden="true" className="text-accent ml-auto shrink-0 text-xs">
                  ▪
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
