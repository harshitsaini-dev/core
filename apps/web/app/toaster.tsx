'use client';

import { useToasts } from '@/lib/client/toast-store';

/**
 * Where toasts appear.
 *
 * Bottom-anchored, and on a phone it clears the navigation bar rather than
 * sitting on top of it. That is not a nicety: the stack spans the full width,
 * so parked over the bar it swallows the taps meant for it — which is exactly
 * how this was found, by a test that deleted an item and then could not reach
 * the trash tab.
 *
 * `aria-live="polite"` rather than `assertive`: these are confirmations, and
 * interrupting a screen reader mid-sentence to say "copied" is worse than
 * saying it a moment later. Anything urgent enough for `assertive` should not
 * be a toast at all.
 */
export function Toaster() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      // `pointer-events-none` on the stack, restored per toast: a toast that
      // covers the bottom of the screen must not eat taps meant for what is
      // behind it.
      // 3.75rem is the bar: a 44px row plus its border. The bar is hidden from
      // `sm` upwards, so above that the padding drops back to a normal margin.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-[calc(3.75rem+env(safe-area-inset-bottom))] sm:items-end sm:px-6 sm:pb-4"
      role="status"
      aria-live="polite"
      data-testid="toaster"
    >
      {toasts.map((entry) => (
        <div
          key={entry.id}
          data-testid="toast"
          data-tone={entry.tone}
          className={[
            'pointer-events-auto flex w-full max-w-sm items-center justify-between gap-3 border bg-black px-3 py-2 font-mono text-xs',
            entry.tone === 'danger'
              ? 'border-danger text-danger'
              : entry.tone === 'warning'
                ? 'border-warning text-warning'
                : 'border-accent text-accent shadow-glow-soft',
          ].join(' ')}
        >
          <span className="min-w-0 flex-1 truncate">
            {/* A glyph as well as a colour: the palette is one hue, and a
                border colour alone is invisible to a large minority. */}
            <span aria-hidden="true">{entry.tone === 'info' ? '> ' : '! '}</span>
            {entry.message}
          </span>

          {entry.action ? (
            <button
              type="button"
              onClick={() => {
                entry.action?.run();
                dismiss(entry.id);
              }}
              data-testid="toast-action"
              className="shrink-0 tracking-widest uppercase underline underline-offset-4"
            >
              {entry.action.label}
            </button>
          ) : null}

          {/*
            Always, including on a toast that offers an action.
            It used to be the `else` of that branch, so `Moved to trash — undo`
            had exactly two exits: undo the thing you meant to do, or reload the
            page. Somebody who simply wanted the message gone had to reverse
            their own delete to get rid of it.
          */}
          <button
            type="button"
            onClick={() => dismiss(entry.id)}
            aria-label="dismiss"
            data-testid="toast-dismiss"
            className="shrink-0"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
