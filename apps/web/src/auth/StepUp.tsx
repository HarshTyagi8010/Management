import { createContext, use, useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { sessionResponseSchema } from '@bizmgmt/contracts';
import { Button, Dialog, FormField, InlineAlert, Input } from '@bizmgmt/ui';
import { api, ApiError } from '../lib/api';
import { useSession } from './session';

type Run = <T>(action: () => Promise<T>) => Promise<T>;

const StepUpContext = createContext<Run | null>(null);

/**
 * Wraps a sensitive action. If the server answers MFA_REQUIRED, asks for an
 * authenticator code (or explains that MFA must be turned on), then retries once.
 */
export function useStepUp(): Run {
  const run = use(StepUpContext);
  if (!run) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return run;
}

interface Pending {
  mode: 'verify' | 'enrol';
  resolve: () => void;
  reject: (reason: Error) => void;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { setSession } = useSession();
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<Pending | null>(null);

  const run = useCallback<Run>(async (action) => {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'MFA_REQUIRED') throw err;
      const mode = err.details.some((d) => d.message === 'enrolment_required') ? 'enrol' : 'verify';
      await new Promise<void>((resolve, reject) => {
        const next = { mode, resolve, reject } as const;
        pendingRef.current = next;
        setCode('');
        setError(null);
        setPending(next);
      });
      return action();
    }
  }, []);

  const close = () => {
    pendingRef.current?.reject(new ApiError(403, 'MFA_REQUIRED', 'The action was not confirmed.'));
    pendingRef.current = null;
    setPending(null);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await api('/auth/mfa/step-up', { method: 'POST', body: { code: code.trim() }, schema: sessionResponseSchema }));
      const current = pendingRef.current;
      pendingRef.current = null;
      setPending(null);
      current?.resolve();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepUpContext value={run}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => !open && close()}
        title={pending?.mode === 'enrol' ? 'Turn on two-step verification' : 'Confirm it’s you'}
        description={
          pending?.mode === 'enrol'
            ? 'This action changes who can access your business, so it needs two-step verification on your account.'
            : 'Enter the 6-digit code from your authenticator app to continue.'
        }
      >
        {pending?.mode === 'enrol' ? (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Not now
            </Button>
            <Button asChild onClick={close}>
              <Link to="/account#two-step">Set up two-step verification</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            {error && <InlineAlert>{error}</InlineAlert>}
            <FormField label="Authentication code" required hint="A recovery code also works.">
              {(field) => (
                <Input {...field} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={11} />
              )}
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || code.trim().length < 6}>
                {busy ? 'Checking…' : 'Confirm'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </StepUpContext>
  );
}
