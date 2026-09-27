import * as React from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui Input with neutral invalid states: errors never encode risk by color.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex min-h-12 w-full min-w-0 rounded-sm border border-input bg-background px-4 py-3 text-base text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-foreground aria-invalid:border-2',
        className,
      )}
      {...props}
    />
  );
}
export { Input };
