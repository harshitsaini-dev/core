import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_TOAST_LIFETIME_MS, TOAST_LIFETIME_MS, useToasts } from './toast-store';

/**
 * How long a toast stays.
 *
 * The interesting case is the one with an action. It used to have no timer at
 * all — the reasoning being that withdrawing an "undo" while somebody is still
 * reading is worse than leaving it — and "no timer" turned out to mean "until
 * the page is reloaded".
 */

describe('toast lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.getState().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears a plain toast', () => {
    useToasts.getState().push('saved');
    expect(useToasts.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(TOAST_LIFETIME_MS + 1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('gives one with an action longer', () => {
    // Long enough to read what happened and reach for the way back.
    useToasts.getState().push('moved to trash', { action: { label: 'undo', run: () => {} } });

    vi.advanceTimersByTime(TOAST_LIFETIME_MS + 1);
    expect(useToasts.getState().toasts, 'withdrawn as fast as a plain one').toHaveLength(1);
  });

  it('clears one with an action eventually', () => {
    // The bug: it never did. `Moved to trash — undo` had two exits, undoing the
    // thing you meant to do or reloading the page.
    useToasts.getState().push('moved to trash', { action: { label: 'undo', run: () => {} } });

    vi.advanceTimersByTime(ACTION_TOAST_LIFETIME_MS + 1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
