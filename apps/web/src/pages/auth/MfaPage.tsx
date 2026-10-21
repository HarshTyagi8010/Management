import { useState } from 'react';
import { sessionResponseSchema } from '@bizmgmt/contracts';
import { Button, FormField, Input } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { api } from '../../lib/api';
import { AuthLayout, useFormSubmit } from './AuthLayout';

/** Second sign-in step for accounts with two-step verification. */
export function MfaPage() {
  const { setSession, signOut } = useSession();
  const [code, setCode] = useState('');

  const form = useFormSubmit(
    () => api('/auth/mfa/verify', { method: 'POST', body: { code: code.trim() }, schema: sessionResponseSchema }),
    // RequirePendingMfa then moves on to the requested page.
    (session) => setSession(session),
  );

  return (
    <AuthLayout
      title="Two-step verification"
      description="Enter the 6-digit code from your authenticator app."
      footer={
        <button type="button" className="cursor-pointer text-accent underline-offset-2 hover:underline" onClick={() => void signOut()}>
          Sign in as someone else
        </button>
      }
    >
      <form onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4">
        {form.alert}
        <FormField label="Authentication code" required hint="Lost your phone? Enter one of your recovery codes instead.">
          {(f) => <Input {...f} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={11} autoFocus />}
        </FormField>
        <Button type="submit" disabled={form.busy || code.trim().length < 6}>
          {form.busy ? 'Checking…' : 'Verify'}
        </Button>
      </form>
    </AuthLayout>
  );
}
