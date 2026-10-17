import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        critical: 'border-transparent bg-sev-critical/15 text-sev-critical',
        high: 'border-transparent bg-sev-high/15 text-sev-high',
        medium: 'border-transparent bg-sev-medium/15 text-sev-medium',
        low: 'border-transparent bg-sev-low/15 text-sev-low',
        unknown: 'border-transparent bg-sev-unknown/15 text-sev-unknown',
        ok: 'border-transparent bg-ok/15 text-ok',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
