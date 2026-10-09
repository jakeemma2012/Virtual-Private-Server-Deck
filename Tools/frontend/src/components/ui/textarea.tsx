'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * IME-safe textarea — same half-controlled strategy as <Input>: it keeps its own
 * display value so React never re-writes the DOM mid-composition (the real cause
 * of Vietnamese Telex char-jump on mobile). Parent onChange is lifted only when
 * not composing, and once on compositionend. Drop-in for a native <textarea>.
 */
function Textarea({
  className,
  value,
  onChange,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: React.ComponentProps<'textarea'>) {
  const composingRef = React.useRef(false);
  const isControlled = value !== undefined;
  const [display, setDisplay] = React.useState<string>(value != null ? String(value) : '');

  React.useEffect(() => {
    if (isControlled && !composingRef.current) {
      setDisplay(value != null ? String(value) : '');
    }
  }, [value, isControlled]);

  return (
    <textarea
      data-slot='textarea'
      value={isControlled ? display : undefined}
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-lg border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow,border-color] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className
      )}
      onCompositionStart={(e) => {
        composingRef.current = true;
        onCompositionStart?.(e);
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        if (isControlled) setDisplay(e.currentTarget.value);
        onCompositionEnd?.(e);
        onChange?.(e as unknown as React.ChangeEvent<HTMLTextAreaElement>);
      }}
      onChange={(e) => {
        if (isControlled) setDisplay(e.target.value);
        if (composingRef.current) return;
        onChange?.(e);
      }}
      {...props}
    />
  );
}

export { Textarea };
