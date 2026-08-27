'use client';

import { create } from 'zustand';

/**
 * Blur-all.
 *
 * A single switch that obscures every value on screen while leaving the
 * structure readable — you can still see that there are eleven items and which
 * one is which, you just cannot read what is in them.
 *
 * It is for the moment somebody walks up, or a screen share starts, or a
 * support call needs the vault open but not legible. That is a narrower promise
 * than it sounds and worth stating plainly: it stops a person looking at the
 * screen. It does not stop a screenshot taken by software on the device, and it
 * is not a defence against anything running in the page.
 *
 * Deliberately **not** persisted. A blur that survives a reload is a setting;
 * this is a gesture, and the vault it protects does not survive a reload
 * either.
 */

interface PrivacyState {
  readonly blurred: boolean;
  toggle: () => void;
  set: (blurred: boolean) => void;
}

export const usePrivacy = create<PrivacyState>((set, get) => ({
  blurred: false,
  toggle: () => set({ blurred: !get().blurred }),
  set: (blurred) => set({ blurred }),
}));
