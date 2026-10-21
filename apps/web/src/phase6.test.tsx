import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLE_PERMISSIONS } from '@bizmgmt/contracts';
import { TestApp } from './App';
import { apiState } from './lib/api';
import { mockApi, tenantContext } from './test-api';

/** Synthetic fixtures only. */
const ID = (c: string) => c.repeat(24);
const SLOW = { timeout: 5000 };
const address = { line1: '1 Sample Estate', line2: '', city: 'Mumbai', district: '', stateCode: '27', pincode: '400001' };
const entity = (periodLockDate: string | null) => ({
  id: ID('e'),
  legalName: 'Demo Traders Private Limited (sample)',
  tradeName: '',
  pan: 'ZZZCD0001Z',
  constitution: 'private_limited',
  address,
  email: '',
  phone: '',
  fyStartMonth: 4,
  turnoverBand: 'up_to_5cr',
  workflow: { stockOutPoint: 'dispatch', stockInPoint: 'goods_receipt', allowNegativeStock: false, roundOffTotal: true },
  periodLockDate,
  bankAccounts: [],
  registrationCount: 1,
  logo: null,
  archived: false,
  version: 4,
});
const actor = { id: ID('b'), name: 'Asha Verma' };
const transfer = (pdf: null | { status: 'pending' | 'ready' | 'failed' }) => ({
  id: ID('f'),
  number: 'TRF-000007',
  status: 'dispatched',
  legalEntityId: ID('e'),
  fromWarehouseId: ID('1'),
  fromWarehouseName: 'MAIN · Main godown (sample)',
  toWarehouseId: ID('2'),
  toWarehouseName: 'CITY · City shop (sample)',
  docDate: '2026-10-20',
  note: '',
  lines: [{ lineId: 'l1', itemId: ID('9'), sku: 'BOLT', itemName: 'Bolt (sample)', unitCode: 'NOS', qty: '4', unitCost: '2.000000', value: '8.00' }],
  createdBy: actor,
  createdAt: '2026-10-20T06:00:00.000Z',
  dispatchedBy: actor,
  dispatchedAt: '2026-10-20T06:05:00.000Z',
  receivedBy: null,
  receivedAt: null,
  cancelledAt: null,
  pdf: pdf ? { ...pdf, templateVersion: 'stock-transfer-1', sizeBytes: pdf.status === 'ready' ? 12000 : null, createdAt: '2026-10-20T06:05:02.000Z' } : null,
  version: 1,
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestApp path={path} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  apiState.setCsrfToken(null);
  apiState.setTenantId(null);
});

describe('period locks (FR-CO-05)', () => {
  it('locks a period with a reason', async () => {
    const calls = mockApi({
      'GET /legal-entities': () => Response.json({ data: [entity(null)] }),
      [`PUT /legal-entities/${ID('e')}/period-lock`]: () => Response.json(entity('2026-03-31')),
    });
    renderAt('/settings/period-locks');
    expect(await screen.findByText('No period is locked', {}, SLOW)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/Lock postings up to/), '2026-03-31');
    const lock = screen.getByRole('button', { name: 'Lock period' });
    expect(lock).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/^Reason/), 'FY 2025-26 returns filed');
    await userEvent.click(lock);
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ version: 4, lockDate: '2026-03-31', reason: 'FY 2025-26 returns filed' });
  });

  it('tells someone without period.unlock that they cannot reopen a period', async () => {
    mockApi({
      'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.accountant)),
      'GET /legal-entities': () => Response.json({ data: [entity('2026-03-31')] }),
    });
    renderAt('/settings/period-locks');
    expect(await screen.findByText('Locked up to 31-03-2026', {}, SLOW)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText(/Lock postings up to/));
    await userEvent.type(screen.getByLabelText(/^Reason/), 'Need to fix March');
    expect(screen.getByText(/This reopens a closed period/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reopen period' })).toHaveProperty('disabled', true);
    expect(screen.getByText('You can move the lock forward but not back.')).toBeTruthy();
  });
});

describe('transfer notes (ADR-006)', () => {
  it('says the note is being prepared until the worker has made it', async () => {
    mockApi({ [`GET /stock-transfers/${ID('f')}`]: () => Response.json(transfer(null)) });
    renderAt(`/inventory/transfers/${ID('f')}`);
    expect(await screen.findByText('Preparing the transfer note…', {}, SLOW)).toBeTruthy();
  });

  it('downloads the ready note with the business header', async () => {
    const created: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b.type), 'blob:test'), revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const calls = mockApi({
      [`GET /stock-transfers/${ID('f')}`]: () => Response.json(transfer({ status: 'ready' })),
      [`GET /stock-transfers/${ID('f')}/pdf`]: () => new Response('%PDF-1.7', { headers: { 'Content-Type': 'application/pdf' } }),
    });
    apiState.setTenantId('a'.repeat(24));
    renderAt(`/inventory/transfers/${ID('f')}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Download transfer note (PDF)' }, SLOW));
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    const download = calls.find((c) => c.path.endsWith('/pdf'));
    expect(download?.headers.get('X-Tenant-Id')).toBe('a'.repeat(24));
    expect(created).toEqual(['application/pdf']);
  });
});

describe('automatic checks', () => {
  it('shows the latest scheduled check results on the stock page', async () => {
    mockApi({
      'GET /legal-entities': () => Response.json({ data: [entity(null)] }),
      'GET /warehouses': () => Response.json({ data: [] }),
      'GET /stock/summary': () => Response.json({ data: [], page: { nextCursor: null, limit: 50 } }),
      'GET /integrity-checks': () =>
        Response.json({
          data: [
            { kind: 'journals', checkedAt: '2026-10-20T01:00:00.000Z', ok: true, issueCount: 0, summary: '12 journals balance and the inventory account matches stock' },
            { kind: 'stock', checkedAt: '2026-10-20T01:00:00.000Z', ok: false, issueCount: 1, summary: '1 difference(s) between stock balances and the stock ledger' },
          ],
        }),
    });
    renderAt('/inventory/stock');
    await userEvent.click(await screen.findByRole('tab', { name: 'Check records' }, SLOW));
    expect(await screen.findByText(/Accounting journals: OK · 12 journals balance/)).toBeTruthy();
    expect(screen.getByText(/Stock: Differences found · 1 difference/)).toBeTruthy();
  });
});
