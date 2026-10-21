import { Slot } from 'radix-ui';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '../cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-contrast hover:bg-accent-hover',
  secondary: 'border border-border-strong bg-surface text-text hover:bg-surface-muted',
  ghost: 'text-text hover:bg-surface-muted',
  danger: 'bg-danger text-white hover:opacity-90',
};

const sizes: Record<ButtonSize, string> = {
  // Both sizes exceed the WCAG 2.2 target-size minimum (24×24 px).
  sm: 'h-8 gap-1.5 px-3 text-[0.8125rem]',
  md: 'h-10 gap-2 px-4 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the child element (e.g. a router link) with button styling. */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string) {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({ variant = 'primary', size = 'md', asChild, className, type, ...props }: ButtonProps) {
  if (asChild) return <Slot.Root className={buttonClasses(variant, size, className)} {...props} />;
  return <button type={type ?? 'button'} className={buttonClasses(variant, size, className)} {...props} />;
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'asChild'> {
  /** Accessible name; icon-only buttons must always have one. */
  label: string;
  icon: React.ReactNode;
}

export function IconButton({ label, icon, variant = 'ghost', className, ...props }: IconButtonProps) {
  return (
    <Button variant={variant} aria-label={label} title={label} className={cn('w-10 px-0', className)} {...props}>
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
    </Button>
  );
}
