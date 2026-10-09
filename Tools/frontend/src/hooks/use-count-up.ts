'use client';

import * as React from 'react';

/**
 * Animate a number toward `target` with an easeOutCubic ramp.
 *
 * - Uses requestAnimationFrame (the rAF timestamp, no Date.now), runs only for
 *   `duration` ms when the target changes, then stops — so it never re-renders
 *   on idle and is safe to sprinkle on dashboard stats.
 * - Respects `prefers-reduced-motion`: jumps straight to the value.
 *
 * Returns the current animated value rounded to `decimals`. Format it yourself
 * at the call site (e.g. `value.toFixed(1)` or `Math.round(value)`).
 */
export function useCountUp(
  target: number,
  opts?: { duration?: number; decimals?: number }
): number {
  const { duration = 600, decimals = 0 } = opts ?? {};
  const [value, setValue] = React.useState(target);
  const fromRef = React.useRef(target);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const safeTarget = Number.isFinite(target) ? target : 0;
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const from = fromRef.current;
    if (prefersReduced || from === safeTarget) {
      fromRef.current = safeTarget;
      setValue(safeTarget);
      return;
    }

    let start = 0;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      setValue(from + (safeTarget - from) * ease(p));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = safeTarget;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
