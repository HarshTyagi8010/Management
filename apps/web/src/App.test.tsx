import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLE_PERMISSIONS } from '@bizmgmt/contracts';
import { TestApp } from './App';
import { initials } from './app/TopBar';
import { apiState } from './lib/api';
import { authenticatedSession, CSRF, error, mockApi, tenantContext, TENANT_ID } from './test-api';

function renderAt(path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestApp path={path} />
    </QueryClientProvider>,
  );
}

/** Renders a signed-in page and waits for its heading. */
async function openPage(path: string, heading: string | RegExp) {
  renderAt(path);
  // Generous wait: the full suite runs a MongoDB replica set and many workers at once.
  return screen.findByRole('heading', { level: 1, name: heading }, { timeout: 10_000 });
}

beforeEach(() => {
  // jsdom has no layout engine; Recharts' ResponsiveContainer needs ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  apiState.setCsrfToken(null);
  apiState.setTenantId(null);
  delete document.documentElement.dataset.theme;
});

describe('dashboard', () => {
  it('renders one h1, a visible sample-data notice and the five KPIs', async () => {
    mockApi();
    await openPage('/', 'Dashboard');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('note').textContent).toMatch(/Sample data/);
    const kpis = within(screen.getByRole('list', { name: 'Key figures' })).getAllByRole('listitem');
    expect(kpis).toHaveLength(5);
    // Exact INR text is present for screen readers (not only the compact form).
    expect(screen.getAllByText('₹18,45,320.00').length).toBeGreaterThan(0);
  });

  it('never labels anything as profit', async () => {
    mockApi();
    await openPage('/', 'Dashboard');
    expect(document.body.textContent).not.toMatch(/profit/i);
  });

  it('shows API status validated against the contract', async () => {
    mockApi();
    await openPage('/', 'Dashboard');
    expect((await screen.findAllByText('OK · v0.1.0', {}, { timeout: 5_000 })).length).toBeGreaterThan(0);
  });

  it('reports the API as unreachable when the response violates the contract', async () => {
    mockApi({ 'GET /health': () => Response.json({ status: 'ok', unexpected: true }) });
    await openPage('/', 'Dashboard');
    expect((await screen.findAllByText('Unreachable', {}, { timeout: 5_000 })).length).toBeGreaterThan(0);
  });

  it('switches the chart to an accessible table', async () => {
    mockApi();
    await openPage('/', 'Dashboard');
    // The chart is lazy-loaded; on a cold transform cache Recharts can take well over 10 s to load.
    await userEvent.click(await screen.findByRole('button', { name: 'Show table' }, { timeout: 25_000 }));
    expect(screen.getAllByRole('table', { name: 'Sales and purchases by month' }).length).toBe(1);
    expect(screen.getAllByText('₹19,50,300.00').length).toBeGreaterThan(0);
  }, 30_000);

  it('filters follow-ups by day', async () => {
    mockApi();
    await openPage('/', 'Dashboard');
    await userEvent.click(screen.getByRole('button', { name: /^Tue\s*20\s*October 2026: 1 item$/ }));
    expect(screen.getByText('PO/26-27/0088 delivery')).toBeTruthy();
    expect(screen.queryByText('INV/26-27/0440 due')).toBeNull();
  });
});

describe('navigation and planned modules', () => {
  it('marks the current page in navigation and shows an honest placeholder', async () => {
    mockApi();
    await openPage('/sales/credit-notes', 'Credit notes');
    expect(screen.getByText('Planned for Phase 9')).toBeTruthy();
    const current = document.querySelectorAll('[aria-current="page"]');
    expect([...current].every((el) => el.textContent === 'Credit notes')).toBe(true);
    expect(current.length).toBeGreaterThan(0);
  });

  it('expands navigation groups with aria-expanded', async () => {
    mockApi();
    await openPage('/', 'Dashboard');
    const [purchases] = screen.getAllByRole('button', { name: 'Purchases' });
    expect(purchases?.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(purchases!);
    expect(purchases?.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders a not-found page for unknown routes', async () => {
    mockApi();
    await openPage('/nope', 'Page not found');
  });

  it('cycles the theme and saves it to the account, not the browser', async () => {
    const calls = mockApi({ 'PATCH /auth/preferences': () => new Response(null, { status: 204 }) });
    await openPage('/', 'Dashboard');
    await userEvent.click(screen.getByRole('button', { name: /Theme: system/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
    await userEvent.click(screen.getByRole('button', { name: /Theme: light/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    const saves = calls.filter((c) => c.path === '/auth/preferences');
    expect(saves.map((c) => c.body)).toEqual([{ theme: 'light' }, { theme: 'dark' }]);
  });

  it('applies the saved theme on load', async () => {
    mockApi({ 'GET /auth/session': () => Response.json(authenticatedSession({ user: { id: 'b'.repeat(24), name: 'Asha Verma', email: 'asha@example.test', mfaEnabled: false, preferences: { theme: 'dark' } } })) });
    await openPage('/', 'Dashboard');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('sign-in', () => {
  it('sends anonymous visitors to sign in, then back to the page they wanted', async () => {
    let signedIn = false;
    const calls = mockApi({
      'GET /auth/session': () => Response.json(signedIn ? authenticatedSession() : { status: 'anonymous', csrfToken: CSRF }),
      'POST /auth/login': () => {
        signedIn = true;
        return Response.json(authenticatedSession({ csrfToken: 'rotated-token' }));
      },
    });
    renderAt('/sales/invoices');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await userEvent.type(screen.getByLabelText(/Email/), 'asha@example.test');
    await userEvent.type(screen.getByLabelText(/Password/), 'a long passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Invoices' });

    const login = calls.find((c) => c.path === '/auth/login');
    expect(login?.headers.get('X-CSRF-Token')).toBe(CSRF);
    expect(login?.body).toEqual({ email: 'asha@example.test', password: 'a long passphrase' });
    // After sign-in the rotated token and the active business are sent.
    const context = calls.find((c) => c.path === '/tenant/context');
    expect(context?.headers.get('X-Tenant-Id')).toBe(TENANT_ID);
  });

  it('shows the server’s message when sign-in fails', async () => {
    mockApi({
      'GET /auth/session': () => Response.json({ status: 'anonymous', csrfToken: CSRF }),
      'POST /auth/login': () => error(401, 'UNAUTHENTICATED', 'Incorrect email or password'),
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText(/Email/), 'asha@example.test');
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong password here');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Incorrect email or password');
  });

  it('asks for the two-step code when the account has MFA', async () => {
    let state: 'anonymous' | 'mfa_required' | 'authenticated' = 'anonymous';
    const calls = mockApi({
      'GET /auth/session': () => Response.json(state === 'authenticated' ? authenticatedSession() : { status: state, csrfToken: CSRF }),
      'POST /auth/login': () => {
        state = 'mfa_required';
        return Response.json({ status: 'mfa_required', csrfToken: 'pending-token' });
      },
      'POST /auth/mfa/verify': () => {
        state = 'authenticated';
        return Response.json(authenticatedSession());
      },
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText(/Email/), 'asha@example.test');
    await userEvent.type(screen.getByLabelText(/Password/), 'a long passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Two-step verification' });
    await userEvent.type(screen.getByLabelText(/Authentication code/), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    expect(calls.find((c) => c.path === '/auth/mfa/verify')?.headers.get('X-CSRF-Token')).toBe('pending-token');
  });

  it('explains when the user belongs to no business', async () => {
    mockApi({ 'GET /auth/session': () => Response.json(authenticatedSession({ tenants: [], activeTenantId: null })) });
    renderAt('/');
    expect(await screen.findByText('You’re not part of any business')).toBeTruthy();
  });

  it('signs out from the account menu', async () => {
    let signedIn = true;
    mockApi({
      'GET /auth/session': () => Response.json(signedIn ? authenticatedSession() : { status: 'anonymous', csrfToken: CSRF }),
      'POST /auth/logout': () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    await openPage('/', 'Dashboard');
    await userEvent.click(screen.getByRole('button', { name: /account menu for Asha Verma/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
  });
});

describe('users and roles', () => {
  const role = (id: string, name: string, system = true) => ({ id, name, description: `${name} role`, system, systemKey: system ? name.toLowerCase() : null, permissions: ['party.view'], memberCount: 1, version: 0 });
  const roles = [role('1'.repeat(24), 'Owner'), role('2'.repeat(24), 'Sales')];
  const members = [
    { id: '3'.repeat(24), userId: 'b'.repeat(24), name: 'Asha Verma', email: 'asha@example.test', status: 'active', roles: [{ id: '1'.repeat(24), name: 'Owner' }], legalEntityIds: null, warehouseIds: null, mfaEnabled: false, lastLoginAt: '2026-10-19T06:30:00.000Z', isSelf: true, version: 0 },
    { id: '4'.repeat(24), userId: 'd'.repeat(24), name: 'Ravi Kumar', email: 'ravi@example.test', status: 'active', roles: [{ id: '2'.repeat(24), name: 'Sales' }], legalEntityIds: null, warehouseIds: null, mfaEnabled: true, lastLoginAt: null, isSelf: false, version: 2 },
  ];

  it('lists people and confirms sensitive changes with a two-step code', async () => {
    let confirmed = false;
    const calls = mockApi({
      'GET /members': () => Response.json({ data: members }),
      'GET /roles': () => Response.json({ data: roles }),
      'GET /invitations': () => Response.json({ data: [] }),
      'POST /invitations': (call) =>
        confirmed
          ? Response.json({ id: '5'.repeat(24), email: (call.body as { email: string }).email, roles: [{ id: '2'.repeat(24), name: 'Sales' }], invitedBy: 'Asha Verma', createdAt: '2026-10-19T06:30:00.000Z', expiresAt: '2026-10-26T06:30:00.000Z' }, { status: 201 })
          : error(403, 'MFA_REQUIRED', 'Confirm it’s you', [{ path: 'mfa', message: 'step_up' }]),
      'POST /auth/mfa/step-up': () => {
        confirmed = true;
        return Response.json(authenticatedSession({ csrfToken: 'stepped-up' }));
      },
    });
    await openPage('/settings/users', 'Users & roles');
    expect(await screen.findAllByText('Ravi Kumar')).toBeTruthy();
    expect(screen.getAllByText('Manage your own access in Account').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite someone' });
    await userEvent.type(within(dialog).getByLabelText(/Email/), 'new.person@example.test');
    await userEvent.click(within(dialog).getByLabelText(/^Sales/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));

    const stepUp = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await userEvent.type(within(stepUp).getByLabelText(/Authentication code/), '654321');
    await userEvent.click(within(stepUp).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Invitation sent to new.person@example.test.')).toBeTruthy();

    const invites = calls.filter((c) => c.path === '/invitations' && c.method === 'POST');
    expect(invites).toHaveLength(2);
    expect(invites[1]?.headers.get('X-CSRF-Token')).toBe('stepped-up');
    expect(invites[1]?.body).toEqual({ email: 'new.person@example.test', roleIds: ['2'.repeat(24)], legalEntityIds: null, warehouseIds: null });
  });

  it('shows built-in roles as read-only', async () => {
    mockApi({ 'GET /members': () => Response.json({ data: members }), 'GET /roles': () => Response.json({ data: roles }), 'GET /invitations': () => Response.json({ data: [] }) });
    await openPage('/settings/users', 'Users & roles');
    await userEvent.click(await screen.findByRole('tab', { name: 'Roles' }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'View Sales' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Sales' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByText('View customers and suppliers')).toBeTruthy();
  });

  it('hides people management from roles without permission (server still enforces)', async () => {
    mockApi({ 'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.sales)) });
    await openPage('/settings/users', 'Users & roles');
    expect(await screen.findByText('You don’t have access to this')).toBeTruthy();
  });
});

describe('audit log', () => {
  it('shows events in IST with their changes', async () => {
    mockApi({
      'GET /audit-events': () =>
        Response.json({
          data: [{ id: '6'.repeat(24), at: '2026-10-19T06:30:00.000Z', action: 'role.updated', actor: { id: 'b'.repeat(24), name: 'Asha Verma' }, entityType: 'role', entityId: '2'.repeat(24), summary: 'Updated role "Cashier"', changes: [{ field: 'permissions', from: ['receipt.post'], to: ['payment.post'] }], requestId: 'r1' }],
          page: { nextCursor: null, limit: 50 },
        }),
    });
    await openPage('/settings/audit', 'Audit log');
    expect((await screen.findAllByText('19-10-2026 12:00', {}, { timeout: 5_000 })).length).toBeGreaterThan(0);
    expect(screen.getAllByText('added payment.post; removed receipt.post').length).toBeGreaterThan(0);
  });

  it('shows no access without audit.view', async () => {
    mockApi({ 'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.storekeeper)) });
    await openPage('/settings/audit', 'Audit log');
    expect(await screen.findByText('You don’t have access to this')).toBeTruthy();
  });
});

describe('initials', () => {
  it.each([
    ['Asha Verma (test)', 'AV'],
    ['ravi', 'R'],
    ['  ', '?'],
  ])('%s → %s', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});
