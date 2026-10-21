import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { sessionResponseSchema } from '@bizmgmt/contracts';
import { Button, FormField, Input } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { api } from '../../lib/api';
import { AuthLayout, useFormSubmit } from './AuthLayout';

/** Where to go after signing in; only same-app paths are accepted (no open redirect). */
export interface ReturnState {
  next?: string;
  inviteToken?: string;
}

export function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const { setSession } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnState = (location.state ?? {}) as ReturnState;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const form = useFormSubmit(
    () => api('/auth/login', { method: 'POST', body: { email, password }, schema: sessionResponseSchema }),
    (session) => {
      // When fully signed in, PublicOnly redirects to the requested page.
      if (session.status === 'mfa_required') navigate('/mfa', { replace: true, state: returnState });
      setSession(session);
    },
  );

  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to your business."
      footer={
        <>
          New to BizMgmt? <Link to="/signup" className="font-medium text-accent underline-offset-2 hover:underline">Create an account</Link>
        </>
      }
    >
      <form onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4">
        {form.alert}
        <FormField label="Email" required error={form.fieldErrors.email}>
          {(f) => <Input {...f} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </FormField>
        <FormField label="Password" required error={form.fieldErrors.password}>
          {(f) => <Input {...f} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </FormField>
        <div className="-mt-1 text-right text-sm">
          <Link to="/forgot-password" className="text-accent underline-offset-2 hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" disabled={form.busy || !email || !password}>
          {form.busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  );
}
