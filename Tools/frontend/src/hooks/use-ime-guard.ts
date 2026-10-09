'use client';

import * as React from 'react';

/**
 * Make a *raw* controlled <input>/<textarea> IME-safe (prevents Vietnamese Telex
 * char-jump) when you can't swap it for the <Input>/<Textarea> components.
 *
 * Usage:
 *   <input value={x} {...useImeGuard<HTMLInputElement>(e => setX(e.target.value))} />
 *
 * Pass your existing onChange in; spread the returned props and do NOT also set
 * onChange/onCompositionStart/onCompositionEnd separately (they'd be overridden).
 */
export function useImeGuard<T extends HTMLInputElement | HTMLTextAreaElement>(
  onChange?: (e: React.ChangeEvent<T>) => void
) {
  const composingRef = React.useRef(false);

  return {
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: (e: React.CompositionEvent<T>) => {
      composingRef.current = false;
      onChange?.(e as unknown as React.ChangeEvent<T>);
    },
    onChange: (e: React.ChangeEvent<T>) => {
      if (composingRef.current) return; // mid-composition -> don't clobber buffer
      onChange?.(e);
    }
  };
}
