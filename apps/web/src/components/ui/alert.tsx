import type * as React from 'react';
import { cn } from '@/lib/utils';

export function Alert({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & { variant?: 'default' | 'destructive' }) {
  return (
    <div
      role="alert"
      className={cn(
        'relative flex w-full gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        variant === 'destructive' && 'border-destructive/40 text-destructive',
        className,
      )}
      {...props}
    />
  );
}
