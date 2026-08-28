'use client';

import { create } from 'zustand';

/**
 * Checking a password against known breaches.
 *
 * The k-anonymity trick: hash the password with SHA-1, send the first five hex
 * characters, and get back every leaked hash that starts the same way. The
 * password is never sent and cannot be reconstructed from what is — the prefix
 * is one bucket in about a million, holding every password whose hash begins
 * that way.
 *
 * SHA-1 is not a mistake here. It is not being used for security; it is the
 * index the corpus is published under, and the comparison happens locally.
 *
 * **Off by default, and asked for explicitly.** This is the only part of the
 * product that talks to anything beyond the vault's own server, and a
 * zero-knowledge tool that quietly started making outbound requests on behalf
 * of the person using it would be lying about what it is. The switch is a
 * disclosure, not a preference.
 */

const ENABLED_KEY = 'core.breach-check';

/** Prefixes already fetched this session. Cleared with the page. */
const cache = new Map<string, Map<string, number>>();

interface BreachSettings {
  readonly enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Read the stored preference. Called after mount, never during render. */
  hydrate: () => void;
}

export const useBreachSettings = create<BreachSettings>((set) => ({
  // Starts off, always. Reading storage during the first render disagrees with
  // what the server produced, and defaulting to on would be the wrong direction
  // to be wrong in.
  enabled: false,

  setEnabled: (on) => {
    set({ enabled: on });
    try {
      localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off');
    } catch {
      // Private mode, a full quota, storage switched off. The switch still
      // holds for this session; it just will not be remembered.
    }
  },

  hydrate: () => {
    if (typeof localStorage === 'undefined') return;
    set({ enabled: localStorage.getItem(ENABLED_KEY) === 'on' });
  },
}));

/** SHA-1 of a password, uppercase hex — the form the corpus is indexed by. */
async function sha1Hex(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * Parse the range response.
 *
 * Lines of `SUFFIX:COUNT`. The padding entries the API adds carry a count of
 * zero, so they parse like any other line and simply never match a real
 * lookup — nothing here has to know they exist.
 */
export function parseRange(body: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const line of body.split('\n')) {
    const [suffix, count] = line.trim().split(':');
    if (!suffix || !count) continue;

    const parsed = Number(count);
    if (Number.isFinite(parsed)) counts.set(suffix.toUpperCase(), parsed);
  }

  return counts;
}

async function rangeFor(prefix: string): Promise<Map<string, number>> {
  const known = cache.get(prefix);
  if (known) return known;

  const response = await fetch(`/api/breach?prefix=${prefix}`);
  if (!response.ok) throw new Error('The breach service did not answer.');

  const counts = parseRange(await response.text());
  cache.set(prefix, counts);
  return counts;
}

/**
 * How many times a password appears in the corpus.
 *
 * Zero means it was not found, which is not the same as safe — the corpus is
 * what has leaked and been published, not what is guessable. That distinction
 * belongs in the wording wherever this number is shown.
 */
export async function breachCount(password: string): Promise<number> {
  const hash = await sha1Hex(password);
  const counts = await rangeFor(hash.slice(0, 5));
  return counts.get(hash.slice(5)) ?? 0;
}
