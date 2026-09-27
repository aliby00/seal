import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn/ui Button, reduced to the two variants used by SEAL.
const buttonVariants = cva(
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-3 rounded-sm px-5 py-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        ghost: 'text-primary hover:bg-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Button({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp data-slot="button" className={cn(buttonVariants({ variant, className }))} {...props} />
  );
}

export { Button, buttonVariants };
