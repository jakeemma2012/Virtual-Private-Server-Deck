'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * IME-safe input (mobile Vietnamese Telex / CJK).
 *
 * The root cause of "char jumping" is NOT just firing onChange mid-composition —
 * it's that a *controlled* React input re-writes its DOM `value` whenever the
 * component re-renders. If a re-render happens while the IME is still composing
 * (and the lifted state hasn't caught up), React resets the DOM value and wipes
 * the composition buffer.
 *
 * Fix: the input keeps its OWN display value so what React renders always equals
 * what's in the DOM — React therefore never clobbers the field during
 * composition. We lift to the parent's onChange only when NOT composing, and
 * once on compositionend. The displayed value re-syncs from the controlled
 * `value` prop only while not composing.
 */
function Input({
  className,
  type,
  value,
  onChange,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: React.ComponentProps<'input'>) {
  const composingRef = React.useRef(false);
  const isControlled = value !== undefined;
  const [display, setDisplay] = React.useState<string>(value != null ? String(value) : '');

  React.useEffect(() => {
    // Re-sync from the controlled value, but never mid-composition.
    if (isControlled && !composingRef.current) {
      setDisplay(value != null ? String(value) : '');
    }
  }, [value, isControlled]);

  return (
    <input
      type={type}
      data-slot='input'
      value={isControlled ? display : undefined}
      className={cn(
        'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-lg border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className
      )}
      onCompositionStart={(e) => {
        composingRef.current = true; // building a char -> lock parent commits
        onCompositionStart?.(e);
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        if (isControlled) setDisplay(e.currentTarget.value);
        onCompositionEnd?.(e);
        // commit the finished text to the parent exactly once
        onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
      }}
      onChange={(e) => {
        if (isControlled) setDisplay(e.target.value); // keep DOM == rendered value
        if (composingRef.current) return; // mid-composition -> don't lift / re-render parent
        onChange?.(e);
      }}
      {...props}
    />
  );
}

export { Input };
