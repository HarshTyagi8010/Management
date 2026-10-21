import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  mfaEnabledResponseSchema,
  ownSessionSchema,
  PASSWORD_MIN_LENGTH,
  sessionResponseSchema,
  totpSetupResponseSchema,
  type OwnSession,
  type ThemePreference,
  type TotpSetupResponse,
} from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, DataTable, FormField, InlineAlert, Input, Select, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useSession } from '../auth/session';
import { applyTheme } from '../app/theme';
import { formatDateTimeIST } from '../app/permissions';
import { api, ApiError } from '../lib/api';
import { usePageTitle } from './usePageTitle';

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

export function AccountPage() {
  usePageTitle('Account & security');
  const { session } = useSession();
  if (session.status !== 'authenticated') return null;
  return (
    <>
      <h1 className="text-xl font-semibold">Account &amp; security</h1>
      <p className="mt-1 text-sm text-muted">
        Signed in as {session.user.name} ({session.user.email}).
      </p>
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <TwoStepCard />
        <PasswordCard />
        <AppearanceCard />
        <SessionsCard />
      </div>
    </>
  );
}

function AppearanceCard() {
  const { session, setSession } = useSession();
  const theme = session.status === 'authenticated' ? session.user.preferences.theme : 'system';
  const save = useMutation({
    mutationFn: (next: ThemePreference) => api('/auth/preferences', { method: 'PATCH', body: { theme: next } }),
    onMutate: (next) => {
      applyTheme(next);
      if (session.status === 'authenticated') setSession({ ...session, user: { ...session.user, preferences: { theme: next } } });
    },
  });
  return (
    <Card>
      <CardHeader title="Appearance" description="Saved to your account, so it follows you to other devices." />
      <CardBody>
        {save.isError && <InlineAlert className="mb-4">{errorMessage(save.error)}</InlineAlert>}
        <FormField label="Theme">
          {(f) => (
            <Select {...f} value={theme} onChange={(e) => save.mutate(e.target.value as ThemePreference)}>
              <option value="system">Match my device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          )}
        </FormField>
      </CardBody>
    </Card>
  );
}

function PasswordCard() {
  const { setSession } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => api('/auth/password/change', { method: 'POST', body: { currentPassword: current, newPassword: next }, schema: sessionResponseSchema }),
    onSuccess: (s) => {
      setSession(s);
      setCurrent('');
      setNext('');
      setDone(true);
    },
  });
  const fieldErrors = change.error instanceof ApiError ? change.error.fieldErrors() : {};
  return (
    <Card>
      <CardHeader title="Password" description="Changing it signs you out on every other device." />
      <CardBody>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setDone(false);
            change.mutate();
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          {done && <InlineAlert tone="success">Password changed. Other sessions were signed out.</InlineAlert>}
          {change.isError && <InlineAlert>{errorMessage(change.error)}</InlineAlert>}
          <FormField label="Current password" required error={fieldErrors.currentPassword}>
            {(f) => <Input {...f} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </FormField>
          <FormField label="New password" required hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={fieldErrors.newPassword}>
            {(f) => <Input {...f} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
          </FormField>
          <div>
            <Button type="submit" disabled={change.isPending || !current || !next}>
              {change.isPending ? 'Saving…' : 'Change password'}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function TwoStepCard() {
  const { session, setSession } = useSession();
  const enabled = session.status === 'authenticated' && session.user.mfaEnabled;
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!setup) {
      setQr(null);
      return;
    }
    let live = true;
    // Rendered locally to a data: URL; the secret never leaves the browser for a third-party QR service.
    // Loaded on demand: only people setting up two-step verification need the QR encoder.
    void import('qrcode')
      .then((QRCode) => QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 192 }))
      .then((url) => live && setQr(url));
    return () => {
      live = false;
    };
  }, [setup]);

  const start = useMutation({
    mutationFn: () => api('/auth/mfa/totp/setup', { method: 'POST', schema: totpSetupResponseSchema }),
    onSuccess: (s) => {
      setSetup(s);
      setCode('');
    },
  });
  const confirm = useMutation({
    mutationFn: () => api('/auth/mfa/totp/confirm', { method: 'POST', body: { code: code.trim() }, schema: mfaEnabledResponseSchema }),
    onSuccess: (r) => {
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      setSession(r.session);
    },
  });
  const disable = useMutation({
    mutationFn: () => api('/auth/mfa/disable', { method: 'POST', body: { code: code.trim() }, schema: sessionResponseSchema }),
    onSuccess: (s) => {
      setSession(s);
      setCode('');
      setRecoveryCodes(null);
    },
  });
  const error = start.error ?? confirm.error ?? disable.error;

  const codeField = (label: string) => (
    <FormField label={label} required>
      {(f) => <Input {...f} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={11} className="max-w-48" />}
    </FormField>
  );

  return (
    <Card id="two-step">
      <CardHeader
        title="Two-step verification"
        description="Ask for a code from an authenticator app when you sign in and before sensitive changes."
        action={<StatusBadge tone={enabled ? 'success' : 'warning'} label={enabled ? 'On' : 'Off'} />}
      />
      <CardBody className="flex flex-col gap-4">
        {error && <InlineAlert>{errorMessage(error)}</InlineAlert>}
        {recoveryCodes && (
          <InlineAlert tone="success">
            <p className="font-medium">Two-step verification is on. Save these recovery codes now — they won’t be shown again.</p>
            <p className="mt-1 text-xs">Each code works once if you lose your phone.</p>
            <ul aria-label="Recovery codes" className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </InlineAlert>
        )}
        {enabled ? (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              disable.mutate();
            }}
            noValidate
            className="flex flex-col gap-4"
          >
            <p className="text-sm text-muted">To turn it off, enter a current code from your app.</p>
            {codeField('Authentication code')}
            <div>
              <Button type="submit" variant="danger" disabled={disable.isPending || code.trim().length < 6}>
                {disable.isPending ? 'Turning off…' : 'Turn off two-step verification'}
              </Button>
            </div>
          </form>
        ) : setup ? (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              confirm.mutate();
            }}
            noValidate
            className="flex flex-col gap-4"
          >
            <ol className="ml-5 list-decimal space-y-1 text-sm">
              <li>Open an authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password).</li>
              <li>Scan the code below, or enter the setup key by hand.</li>
              <li>Type the 6-digit code the app shows.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-4">
              {qr ? <img src={qr} width={192} height={192} alt="QR code for your authenticator app" className="rounded-md border border-border bg-white" /> : <Skeleton className="size-48" />}
              <div className="min-w-0">
                <p className="text-xs text-muted">Setup key</p>
                <code className="block font-mono text-sm break-all">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              </div>
            </div>
            {codeField('Code from the app')}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={confirm.isPending || code.trim().length !== 6}>
                {confirm.isPending ? 'Checking…' : 'Turn on'}
              </Button>
              <Button variant="secondary" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? 'Preparing…' : 'Set up two-step verification'}
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function SessionsCard() {
  const { tenantId, signOut } = useSession();
  const queryClient = useQueryClient();
  const key = ['account', tenantId, 'sessions'];
  const sessions = useQuery({ queryKey: key, queryFn: ({ signal }) => api('/auth/sessions', { schema: z.object({ data: z.array(ownSessionSchema) }), signal }).then((r) => r.data) });
  const revoke = useMutation({
    mutationFn: (s: OwnSession) => api(`/auth/sessions/${s.id}`, { method: 'DELETE' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const everywhere = useMutation({ mutationFn: () => api('/auth/logout-all', { method: 'POST' }), onSuccess: () => void signOut() });

  const columns: Column<OwnSession>[] = [
    { key: 'device', header: 'Device', primary: true, render: (s) => <span className="break-words">{describeAgent(s.userAgent)}{s.current && <span className="text-muted"> (this device)</span>}</span> },
    { key: 'last', header: 'Last active (IST)', render: (s) => <span className="tabular whitespace-nowrap">{formatDateTimeIST(s.lastSeenAt)}</span> },
    { key: 'started', header: 'Signed in (IST)', render: (s) => <span className="tabular whitespace-nowrap">{formatDateTimeIST(s.createdAt)}</span> },
    {
      key: 'actions',
      header: 'Actions',
      render: (s) =>
        s.current ? null : (
          <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s)} disabled={revoke.isPending} aria-label={`Sign out ${describeAgent(s.userAgent)}`}>
            Sign out
          </Button>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader title="Where you’re signed in" action={<Button size="sm" variant="secondary" onClick={() => everywhere.mutate()} disabled={everywhere.isPending}>Sign out everywhere</Button>} />
      <div className="py-4">
        {sessions.isPending ? (
          <Skeleton className="mx-5 h-24" />
        ) : sessions.isError ? (
          <InlineAlert className="mx-5">{errorMessage(sessions.error)}</InlineAlert>
        ) : (
          <DataTable caption="Signed-in sessions" hideCaption columns={columns} rows={sessions.data} rowKey={(s) => s.id} />
        )}
      </div>
    </Card>
  );
}

/** A short, human description of a user-agent string (best effort; never used for security decisions). */
export function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
