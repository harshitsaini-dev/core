'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Touch gestures.
 *
 * Both of these are touch-only, deliberately. A desktop has buttons for the
 * same actions and a mouse drag that copied a password would be a surprise; a
 * phone has neither the screen width for four buttons per row nor a hover state
 * to reveal them.
 *
 * They are built on touch events rather than pointer events for exactly that
 * reason — a touch event cannot arrive from a mouse, so the gating is a
 * property of the API rather than a check that can be forgotten.
 */

/** How far a finger must travel horizontally before a swipe counts. */
const SWIPE_THRESHOLD_PX = 88;

/**
 * How much further than that it can travel visually. The row stops moving
 * before the finger does, which is what tells you the gesture has armed.
 */
const SWIPE_MAX_PX = 120;

/** A vertical drag this much larger than the horizontal one is a scroll. */
const SCROLL_BIAS = 1.2;

export interface SwipeHandlers {
  onTouchStart: (event: React.TouchEvent) => void;
  onTouchMove: (event: React.TouchEvent) => void;
  onTouchEnd: () => void;
}

export interface SwipeState {
  /** Pixels the row should be translated by, signed. */
  readonly offset: number;
  /** True once the offset is past the point where release would fire. */
  readonly armed: boolean;
  readonly handlers: SwipeHandlers;
}

/**
 * Swipe a row left or right.
 *
 * The gesture only claims the touch once it is clearly horizontal. Getting that
 * wrong is what makes a list feel broken: every attempt to scroll past a row
 * drags it sideways instead.
 */
export function useSwipe({
  onSwipeLeft,
  onSwipeRight,
}: {
  onSwipeLeft?: (() => void) | undefined;
  onSwipeRight?: (() => void) | undefined;
}): SwipeState {
  const origin = useRef<{ x: number; y: number } | null>(null);
  const horizontal = useRef(false);
  // The travelled distance lives in a ref as well as in state. State drives the
  // render; the ref is what release reads, because a render is not guaranteed
  // to have committed between the last move and the finger lifting.
  const travelled = useRef(0);
  const [offset, setOffset] = useState(0);

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    origin.current = { x: touch.clientX, y: touch.clientY };
    horizontal.current = false;
    travelled.current = 0;
  }, []);

  const onTouchMove = useCallback((event: React.TouchEvent) => {
    const touch = event.touches[0];
    const start = origin.current;
    if (!touch || !start) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;

    if (!horizontal.current) {
      // Undecided. A mostly-vertical drag hands the touch back to the scroller
      // for good, so a diagonal thumb does not fight the page.
      if (Math.abs(dy) > Math.abs(dx) * SCROLL_BIAS) {
        origin.current = null;
        return;
      }
      if (Math.abs(dx) < 8) return;
      horizontal.current = true;
    }

    const clamped = Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, dx));
    travelled.current = clamped;
    setOffset(clamped);
  }, []);

  const onTouchEnd = useCallback(() => {
    const distance = travelled.current;

    origin.current = null;
    horizontal.current = false;
    travelled.current = 0;
    setOffset(0);

    if (distance <= -SWIPE_THRESHOLD_PX) onSwipeLeft?.();
    else if (distance >= SWIPE_THRESHOLD_PX) onSwipeRight?.();
  }, [onSwipeLeft, onSwipeRight]);

  return {
    offset,
    armed: Math.abs(offset) >= SWIPE_THRESHOLD_PX,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}

/** How far the list must be dragged down before a release refreshes. */
const PULL_THRESHOLD_PX = 72;

/** Resistance, so the list does not track the finger one-to-one. */
const PULL_RESISTANCE = 0.5;

export interface PullState {
  readonly distance: number;
  readonly armed: boolean;
  readonly refreshing: boolean;
  readonly handlers: SwipeHandlers;
}

/**
 * Pull down to sync.
 *
 * The vault syncs on its own, so this is not the only way to get fresh data —
 * it is the way to *ask*, which matters on a product where "did my change
 * arrive" is a question people genuinely have. The indicator says what happened
 * either way.
 */
export function usePullToRefresh(onRefresh: () => Promise<void>): PullState {
  const origin = useRef<number | null>(null);
  const pulled = useRef(0);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    const touch = event.touches[0];
    // Only from the very top. Starting a pull mid-list would hijack a scroll
    // that had further to go.
    pulled.current = 0;
    if (!touch || window.scrollY > 0) {
      origin.current = null;
      return;
    }
    origin.current = touch.clientY;
  }, []);

  const onTouchMove = useCallback((event: React.TouchEvent) => {
    const touch = event.touches[0];
    const start = origin.current;
    if (!touch || start === null) return;

    const dy = touch.clientY - start;
    if (dy <= 0) {
      pulled.current = 0;
      setDistance(0);
      return;
    }

    const next = Math.min(PULL_THRESHOLD_PX * 1.5, dy * PULL_RESISTANCE);
    pulled.current = next;
    setDistance(next);
  }, []);

  const onTouchEnd = useCallback(() => {
    const travelled = pulled.current;

    origin.current = null;
    pulled.current = 0;
    setDistance(0);

    if (travelled < PULL_THRESHOLD_PX) return;

    setRefreshing(true);
    void onRefresh().finally(() => setRefreshing(false));
  }, [onRefresh]);

  return {
    distance,
    armed: distance >= PULL_THRESHOLD_PX,
    refreshing,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
