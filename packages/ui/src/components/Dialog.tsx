import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../cn';
import { IconButton } from './Button';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Modal dialog (Radix): focus is trapped inside, Escape closes, focus returns to
 * the opener, and the title/description are wired to aria-labelledby/-describedby.
 */
export function Dialog({ open, onOpenChange, title, description, children, className }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
            'rounded-lg border border-border bg-surface p-5 text-text shadow-card focus:outline-none',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
              {description && <RadixDialog.Description className="mt-1 text-[0.8125rem] text-muted">{description}</RadixDialog.Description>}
            </div>
            <RadixDialog.Close asChild>
              <IconButton label="Close" icon={<X size={18} />} className="-mt-1 -mr-2" />
            </RadixDialog.Close>
          </div>
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export type AlertTone = 'danger' | 'success' | 'info' | 'warning';

const alertTones: Record<AlertTone, string> = {
  danger: 'border-danger/40 bg-danger-soft',
  success: 'border-success/40 bg-success-soft',
  info: 'border-info/40 bg-info-soft',
  warning: 'border-warning/40 bg-warning-soft',
};

/** Inline message for form results. Errors use role="alert" so they are announced. */
export function InlineAlert({ tone = 'danger', children, className }: { tone?: AlertTone; children: ReactNode; className?: string }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('rounded-md border px-3 py-2 text-sm text-text', alertTones[tone], className)}>
      {children}
    </div>
  );
}
