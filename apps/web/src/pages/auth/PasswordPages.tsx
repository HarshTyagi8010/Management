import { useState } from 'react';
import { Link } from 'react-router';
import { PASSWORD_MIN_LENGTH } from '@bizmgmt/contracts';
import { Button, FormField, InlineAlert, Input } from '@bizmgmt/ui';
import { api } from '../../lib/api';
import { AuthLayout, takeFragmentToken, useFormSubmit } from './AuthLayout';

const linkClass = 'font-medium text-accent underline-offset-2 hover:underline';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const form = useFormSubmit(
    () => api('/auth/password/forgot', { method: 'POST', body: { email } }),
    () => setSent(true),
  );

  return (
    <AuthLayout title="Reset your password" description="We’ll email you a link to choose a new password." footer={<Link to="/login" className={linkClass}>Back to sign in</Link>}>
      {sent ? (
        // Same message whether or not the account exists (no account enumeration).
        <InlineAlert tone="success">If an account exists for {email}, we’ve sent a reset link. It works for 30 minutes.</InlineAlert>
      ) : (
        <form onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4">
          {form.alert}
          <FormField label="Email" required error={form.fieldErrors.email}>
            {(f) => <Input {...f} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </FormField>
          <Button type="submit" disabled={form.busy || !email}>
            {form.busy ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [token] = useState(takeFragmentToken);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const form = useFormSubmit(
    async () => {
      if (password !== confirm) throw new Error('mismatch');
      await api('/auth/password/reset', { method: 'POST', body: { token, newPassword: password } });
    },
    () => setDone(true),
  );
  const mismatch = confirm.length > 0 && password !== confirm ? 'The passwords don’t match' : undefined;

  if (!token) {
    return (
      <AuthLayout title="Reset your password" footer={<Link to="/forgot-password" className={linkClass}>Request a new link</Link>}>
        <InlineAlert>This reset link is incomplete or has already been used.</InlineAlert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" description="You’ll be signed out everywhere and can sign in with the new password.">
      {done ? (
        <div className="flex flex-col gap-4">
          <InlineAlert tone="success">Your password has been changed.</InlineAlert>
          <Button asChild>
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4">
          {form.alert}
          <FormField label="New password" required hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={form.fieldErrors.newPassword}>
            {(f) => <Input {...f} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </FormField>
          <FormField label="Confirm new password" required error={mismatch}>
            {(f) => <Input {...f} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </FormField>
          <Button type="submit" disabled={form.busy || !password || password !== confirm}>
            {form.busy ? 'Saving…' : 'Change password'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
