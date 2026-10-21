import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CardBody, InlineAlert } from '@bizmgmt/ui';
import { ApiError } from '../../lib/api';
import { usePageTitle } from '../usePageTitle';

/** Centred single-column layout for sign-in flows (no app shell, no navigation). */
export function AuthLayout({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  usePageTitle(title);
  return (
    <div className="min-h-dvh bg-bg px-4 py-10 text-text sm:py-16">
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-md focus:outline-none">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2.5 rounded-md">
          <span aria-hidden="true" className="inline-flex size-9 items-center justify-center rounded-md bg-accent text-base font-bold text-accent-contrast">
            B
          </span>
          <span className="text-lg font-semibold tracking-tight">BizMgmt</span>
        </Link>
        <Card>
          <CardBody className="p-6 sm:p-8">
            <h1 className="text-xl font-semibold">{title}</h1>
            {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
            <div className="mt-6">{children}</div>
          </CardBody>
        </Card>
        {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
      </main>
    </div>
  );
}

/**
 * Submit handling for auth forms: one request at a time, field errors from the
 * server's error details, and a form-level message announced via role="alert".
 */
export function useFormSubmit<T>(action: () => Promise<T>, onSuccess: (result: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      onSuccess(await action());
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors());
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const alert = error ? <InlineAlert className="mb-4">{error}</InlineAlert> : null;
  return { onSubmit, busy, error, fieldErrors, setError, alert };
}

let taken: { path: string; token: string } | null = null;

/**
 * Reads a single-use token from the URL fragment, then removes it from the address bar and history.
 * Remembered per path, because React may run state initialisers twice (Strict Mode).
 */
export function takeFragmentToken(): string | null {
  const path = window.location.pathname;
  const match = /(?:^|[#&])token=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
  if (match?.[1]) {
    taken = { path, token: match[1] };
    window.history.replaceState(window.history.state, '', path + window.location.search);
  }
  return taken?.path === path ? taken.token : null;
}
