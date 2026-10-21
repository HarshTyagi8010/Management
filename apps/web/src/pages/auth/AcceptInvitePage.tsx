import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { invitationInspectResponseSchema, PASSWORD_MIN_LENGTH, sessionResponseSchema } from '@bizmgmt/contracts';
import { Button, FormField, InlineAlert, Input, Skeleton } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { api, apiState, ApiError } from '../../lib/api';
import { AuthLayout, takeFragmentToken, useFormSubmit } from './AuthLayout';

const linkClass = 'font-medium text-accent underline-offset-2 hover:underline';

export function AcceptInvitePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { session, setSession, signOut } = useSession();
  // The token arrives in the URL fragment (never sent to servers or logs), or in history state after signing in.
  const [token] = useState(() => takeFragmentToken() ?? (location.state as { inviteToken?: string } | null)?.inviteToken ?? null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api('/auth/invitations/inspect', { method: 'POST', body: { token }, schema: invitationInspectResponseSchema }),
    enabled: !!token,
    retry: false,
  });

  const form = useFormSubmit(
    () => api('/auth/invitations/accept', { method: 'POST', body: invitation.data?.accountExists ? { token } : { token, name, password }, schema: sessionResponseSchema }),
    (next) => {
      if (next.status === 'authenticated') apiState.setTenantId(next.activeTenantId);
      setSession(next);
      navigate('/', { replace: true });
    },
  );

  if (!token) {
    return (
      <AuthLayout title="Join a business">
        <InlineAlert>This invitation link is incomplete. Open the link from your email again.</InlineAlert>
      </AuthLayout>
    );
  }
  if (invitation.isPending) {
    return (
      <AuthLayout title="Join a business">
        <div role="status" aria-label="Checking invitation">
          <Skeleton className="h-24 w-full" />
        </div>
      </AuthLayout>
    );
  }
  if (invitation.isError || !invitation.data) {
    const message = invitation.error instanceof ApiError ? invitation.error.message : 'We couldn’t check this invitation.';
    return (
      <AuthLayout title="Join a business">
        <InlineAlert>{message}</InlineAlert>
      </AuthLayout>
    );
  }

  const { tenantName, email, accountExists } = invitation.data;
  const signedInAs = session.status === 'authenticated' ? session.user.email : null;

  return (
    <AuthLayout title={`Join ${tenantName}`} description={<>This invitation is for <strong className="text-text">{email}</strong>.</>}>
      {form.alert}
      {accountExists ? (
        signedInAs === email ? (
          <form onSubmit={form.onSubmit}>
            <Button type="submit" className="w-full" disabled={form.busy}>
              {form.busy ? 'Joining…' : `Join ${tenantName}`}
            </Button>
          </form>
        ) : signedInAs ? (
          <div className="flex flex-col gap-4">
            <InlineAlert tone="warning">You’re signed in as {signedInAs}. Sign out, then sign in as {email} to accept.</InlineAlert>
            <Button variant="secondary" onClick={() => void signOut().then(() => navigate('/login', { state: { next: '/accept-invite', inviteToken: token } }))}>
              Sign out and continue
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm">You already have a BizMgmt account. Sign in to accept the invitation.</p>
            <Button asChild>
              <Link to="/login" state={{ next: '/accept-invite', inviteToken: token }}>
                Sign in to accept
              </Link>
            </Button>
          </div>
        )
      ) : (
        <form onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4">
          <FormField label="Your name" required error={form.fieldErrors.name}>
            {(f) => <Input {...f} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label="Choose a password" required hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={form.fieldErrors.password}>
            {(f) => <Input {...f} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </FormField>
          <Button type="submit" disabled={form.busy || !name || !password}>
            {form.busy ? 'Creating account…' : 'Create account and join'}
          </Button>
          <p className="text-xs text-muted">
            Not you? Ignore this invitation, or <Link to="/login" className={linkClass}>sign in</Link> with a different account.
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
