import { AlertCircle, Inbox, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../cn';
import { Button } from './Button';

function StateFrame({ icon, title, children, className, role }: { icon: ReactNode; title: string; children?: ReactNode; className?: string; role?: 'alert' | 'status' }) {
  return (
    <div role={role} className={cn('flex flex-col items-center px-6 py-12 text-center', className)}>
      <span aria-hidden="true" className="inline-flex size-12 items-center justify-center rounded-full bg-surface-muted text-muted">
        {icon}
      </span>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      {children}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <StateFrame icon={icon ?? <Inbox size={22} />} title={title}>
      {description && <p className="mt-1 max-w-md text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </StateFrame>
  );
}

/** Shows a safe message plus the request id for support; never raw server errors. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  requestId,
  onRetry,
}: {
  title?: string;
  message?: string | undefined;
  requestId?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <StateFrame role="alert" icon={<AlertCircle size={22} />} title={title}>
      <p className="mt-1 max-w-md text-muted">{message ?? 'Please try again. If the problem continues, contact support.'}</p>
      {requestId && (
        <p className="mt-2 text-xs text-muted">
          Reference: <code className="tabular">{requestId}</code>
        </p>
      )}
      {onRetry && (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </StateFrame>
  );
}

export function PermissionDenied({ permission }: { permission?: string }) {
  return (
    <StateFrame icon={<Lock size={22} />} title="You don’t have access to this">
      <p className="mt-1 max-w-md text-muted">
        Ask an administrator of your business to grant you access
        {permission ? (
          <>
            {' '}
            (<code>{permission}</code>)
          </>
        ) : null}
        .
      </p>
    </StateFrame>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-surface-muted', className)} />;
}
