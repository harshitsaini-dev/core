import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from 'react';

/**
 * Terminal-theme primitives.
 *
 * Every visual rule from ADR-007 lives here rather than being retyped at each
 * call site: pure black, Matrix green, monospace, square corners, 1px borders,
 * invert on hover. A component that needs to break one of those is a signal to
 * revisit the theme, not to add a one-off class.
 *
 * The palette is a single hue, which is good for OLED and bad for conveying
 * meaning. So state is carried by a glyph prefix and position as well as
 * colour — a red border alone is invisible to a large minority of readers.
 */

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

/**
 * Glow marks what is interactive, and only on hover or focus.
 *
 * A permanently glowing button is just a bright button; the effect has to
 * change to carry information. Ghost buttons stay unlit on purpose — they are
 * the secondary action, and lighting them equally would flatten the hierarchy
 * the variants exist to create.
 */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border-accent text-accent hover:bg-accent hover:text-bg hover:shadow-glow focus-visible:shadow-glow',
  ghost: 'border-line text-muted hover:border-fg hover:text-fg',
  danger:
    'border-danger text-danger hover:bg-danger hover:text-bg hover:shadow-glow-danger focus-visible:shadow-glow-danger',
};

/**
 * The button look, as a class string.
 *
 * Exported so an anchor can be styled as a button without reaching for a
 * polymorphic `asChild` prop and the dependency that usually comes with it. A
 * link that navigates should stay an `<a>`: it belongs in the tab order as a
 * link, opens in a new tab on middle-click, and is announced correctly.
 */
export function buttonClasses(variant: ButtonVariant = 'primary', className?: string): string {
  return cx(
    // min-h-11 is 44px: the smallest target most people can hit reliably with a
    // thumb. The type stays small to suit the terminal look, so the height has
    // to be set explicitly rather than falling out of padding.
    'inline-flex min-h-11 items-center justify-center border px-4 py-2 font-mono text-sm tracking-tight transition-colors',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
    BUTTON_VARIANTS[variant],
    variant === 'primary' ? 'disabled:hover:text-accent' : undefined,
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  return <button {...props} className={buttonClasses(variant, className)} />;
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /**
   * Declared explicitly because `InputHTMLAttributes` does not carry it. React
   * 19 passes `ref` like any other prop, so no `forwardRef` is needed — but the
   * type has to say so or callers cannot focus the field.
   */
  ref?: Ref<HTMLInputElement> | undefined;
}

export function Input({ invalid, className, ...props }: InputProps) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={cx(
        // Matches the button height, and 16px type on mobile specifically:
        // anything smaller makes iOS Safari zoom the viewport on focus, which
        // shoves the rest of the form off screen mid-entry.
        'w-full min-h-11 border bg-black px-3 py-2 font-mono text-base text-fg sm:text-sm',
        'placeholder:text-muted/60',
        'focus:border-accent focus:shadow-glow-soft focus:outline-none',
        invalid ? 'border-danger' : 'border-line',
        className,
      )}
    />
  );
}

export interface FieldProps {
  label: string;
  htmlFor: string;
  /** Shown under the field. Prefixed with a glyph, not just coloured. */
  hint?: ReactNode | undefined;
  /** Replaces the hint when present. */
  error?: string | undefined;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <label
        htmlFor={htmlFor}
        className="block font-mono text-xs uppercase tracking-widest text-muted"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : hint ? (
        <p className="font-mono text-xs text-muted">
          <span aria-hidden="true">&gt; </span>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('border-line bg-surface border p-6 shadow-glow-soft sm:p-8', className)}>
      {children}
    </div>
  );
}

export function Prompt({ children }: { children: ReactNode }) {
  return (
    <span className="flex gap-2">
      <span aria-hidden="true" className="select-none text-accent-dim">
        $
      </span>
      <span>{children}</span>
    </span>
  );
}

/**
 * A callout that must be read, not skimmed.
 *
 * Used for the consequences a user cannot undo — losing a master password,
 * losing the Emergency Kit. Deliberately heavier than the rest of the UI.
 */
export function Warning({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="note" className="border border-warning bg-warning/5 p-4">
      <p className="text-warning font-mono text-xs tracking-widest uppercase">
        <span aria-hidden="true">!! </span>
        {title}
      </p>
      <div className="mt-2 font-mono text-xs leading-relaxed text-fg">{children}</div>
    </div>
  );
}
