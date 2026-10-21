import { useState } from 'react';
import { Link } from 'react-router';
import { PASSWORD_MIN_LENGTH, sessionResponseSchema } from '@bizmgmt/contracts';
import { Button, FormField, Input } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { api } from '../../lib/api';
import { AuthLayout, useFormSubmit } from './AuthLayout';

export function SignupPage() {
  const { setSession } = useSession();
  const [values, setValues] = useState({ name: '', businessName: '', email: '', password: '' });
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));

  const form = useFormSubmit(
    () => api('/auth/signup', { method: 'POST', body: values, schema: sessionResponseSchema }),
    (session) => setSession(session),
  );

  return (
    <AuthLayout
      title="Create your account"
      description="Set up your business. You can add GST registrations and invite your team next."
      footer={
        <>
          Already have an account? <Link to="/login" className="font-medium text-accent underline-offset-2 hover:underline">Sign in</Link>
        </>
      }
    >
      <form onSubmit={form.onSubmit} noValidate className="flex flex-col gap-4">
        {form.alert}
        <FormField label="Your name" required error={form.fieldErrors.name}>
          {(f) => <Input {...f} autoComplete="name" value={values.name} onChange={set('name')} />}
        </FormField>
        <FormField label="Business name" required error={form.fieldErrors.businessName}>
          {(f) => <Input {...f} autoComplete="organization" value={values.businessName} onChange={set('businessName')} />}
        </FormField>
        <FormField label="Work email" required error={form.fieldErrors.email}>
          {(f) => <Input {...f} type="email" autoComplete="email" value={values.email} onChange={set('email')} />}
        </FormField>
        <FormField label="Password" required hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember.`} error={form.fieldErrors.password}>
          {(f) => <Input {...f} type="password" autoComplete="new-password" value={values.password} onChange={set('password')} />}
        </FormField>
        <Button type="submit" disabled={form.busy}>
          {form.busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
