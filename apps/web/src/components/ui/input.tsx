import type * as React from 'react';
import { cn } from '@/lib/utils';

export const fieldClass =
  'flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(fieldClass, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'min-h-24 py-2', className)} {...props} />;
}

export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(fieldClass, 'h-9 pr-8 dark:[&>option]:bg-popover', className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}
