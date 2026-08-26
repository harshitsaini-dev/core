'use client';

/**
 * Copying secrets.
 *
 * The clipboard is shared with every application on the machine and, on some
 * platforms, with other devices signed into the same account. A password left
 * there is a password sitting in the open until something else overwrites it.
 *
 * So a copy here has a deadline. What is worth being precise about is what that
 * deadline can and cannot promise: the clipboard can only be cleared while this
 * tab is alive, and only if nothing else has taken ownership of it since. A
 * closed tab, a killed browser, or a phone that suspended the page all leave
 * the value there. This narrows the window; it does not close it.
 */

export const CLIPBOARD_CLEAR_MS = 30_000;

let pendingClear: ReturnType<typeof setTimeout> | undefined;
let lastCopied: string | null = null;

/**
 * Copy a secret and schedule its removal.
 *
 * Returns false when the browser refuses — Firefox denies clipboard writes
 * outside a user gesture, and every browser denies them over plain HTTP. The
 * caller needs to know, because a silent failure looks exactly like success and
 * the user finds out when they paste.
 */
export async function copySecret(
  value: string,
  clearAfterMs = CLIPBOARD_CLEAR_MS,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return false;
  }

  lastCopied = value;
  if (pendingClear) clearTimeout(pendingClear);

  pendingClear = setTimeout(() => {
    void clearIfUnchanged();
  }, clearAfterMs);

  return true;
}

/**
 * Clear the clipboard, but only if it still holds what we put there.
 *
 * Reading before writing matters: wiping unconditionally would destroy whatever
 * the user copied in the meantime, which is a data loss they did not ask for
 * and would struggle to attribute.
 */
async function clearIfUnchanged(): Promise<void> {
  if (lastCopied === null) return;

  try {
    const current = await navigator.clipboard.readText();
    if (current === lastCopied) {
      await navigator.clipboard.writeText('');
    }
  } catch {
    // Reading is permission-gated in several browsers. Where it is refused,
    // overwrite anyway: leaving a password on the clipboard is the worse of the
    // two failures.
    try {
      await navigator.clipboard.writeText('');
    } catch {
      // Nothing further available.
    }
  } finally {
    lastCopied = null;
    pendingClear = undefined;
  }
}

/** Clear immediately. Used by the panic button and on lock. */
export async function clearClipboardNow(): Promise<void> {
  if (pendingClear) clearTimeout(pendingClear);
  await clearIfUnchanged();
}

/** Short vibration on copy, where the device supports it. */
export function pulse(): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(12);
  }
}
