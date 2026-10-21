import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Button, EmptyState } from '@bizmgmt/ui';
import { AuthLayout } from '../pages/auth/AuthLayout';
import { safeNext, type ReturnState } from '../pages/auth/LoginPage';
import { useSession } from './session';

/** App pages need a complete sign-in; the server enforces this independently (these guards are UX only). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, signOut } = useSession();
  const location = useLocation();
  if (session.status === 'anonymous') return <Navigate to="/login" replace state={{ next: location.pathname + location.search }} />;
  if (session.status === 'mfa_required') return <Navigate to="/mfa" replace state={{ next: location.pathname + location.search }} />;
  if (session.tenants.length === 0) {
    return (
      <AuthLayout title="No business yet">
        <EmptyState
          title="You’re not part of any business"
          description="Ask the owner or an administrator of your business to invite you, then open the link from the email."
          action={
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          }
        />
      </AuthLayout>
    );
  }
  return <>{children}</>;
}

/**
 * Sign-in pages are only for people who are not signed in. Once a sign-in step
 * completes, this guard is what moves the user on, to the page they asked for.
 */
export function PublicOnly() {
  const { session } = useSession();
  const state = (useLocation().state ?? {}) as ReturnState;
  if (session.status === 'authenticated') {
    return <Navigate to={safeNext(state.next)} replace state={state.inviteToken ? { inviteToken: state.inviteToken } : null} />;
  }
  return <Outlet />;
}

export function RequirePendingMfa({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const state = (useLocation().state ?? {}) as ReturnState;
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  if (session.status === 'authenticated') {
    return <Navigate to={safeNext(state.next)} replace state={state.inviteToken ? { inviteToken: state.inviteToken } : null} />;
  }
  return <>{children}</>;
}
