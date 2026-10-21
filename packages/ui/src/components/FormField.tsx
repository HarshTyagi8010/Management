import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import { cn } from '../cn';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
}

export interface FormFieldProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean;
  /** Render the control with the provided accessibility props spread onto it. */
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}

/** Visible label, hint and inline error wired to the control via aria-describedby. */
export function FormField({ label, hint, error, required, children, className }: FormFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[0.8125rem] font-medium">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        )}
      </label>
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
        ...(required ? { 'aria-required': true as const } : {}),
      })}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      className={cn(
        'h-10 w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-muted',
        'aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <select
      className={cn(
        'h-10 w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-sm text-text',
        'aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted',
        className,
      )}
      {...props}
    />
  );
}

/** A labelled checkbox; the whole row is the click target (≥ 24 px). */
export function Checkbox({ label, description, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent" {...props} />
      <label htmlFor={id} className="min-h-6 cursor-pointer text-sm leading-5">
        {label}
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
    </div>
  );
}
