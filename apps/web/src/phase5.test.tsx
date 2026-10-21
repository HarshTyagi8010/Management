import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLE_PERMISSIONS } from '@bizmgmt/contracts';
import { TestApp } from './App';
import { apiState } from './lib/api';
import { error, mockApi, tenantContext } from './test-api';

/** Synthetic fixtures only. */
const ID = (c: string) => c.repeat(24);
const address = { line1: '1 Sample Estate', line2: '', city: 'Mumbai', district: '', stateCode: '27', pincode: '400001' };
const entity = {
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
  periodLockDate: null,
  bankAccounts: [],
  registrationCount: 1,
  logo: null,
  archived: false,
  version: 1,
};
const warehouse = (id: string, code: string, name: string) => ({ id, legalEntityId: ID('e'), code, name, address: null, gstRegistrationId: null, archived: false, version: 0 });
const MAIN = warehouse(ID('1'), 'MAIN', 'Main godown (sample)');
const CITY = warehouse(ID('2'), 'CITY', 'City shop (sample)');
const item = { id: ID('9'), sku: 'BOLT-M8', name: 'Hex bolt M8 (sample)', description: '', type: 'stock', categoryId: null, categoryName: null, baseUnitId: ID('8'), baseUnitCode: 'NOS', altUnits: [], hsnSac: '7318', taxClassId: ID('7'), taxClassName: 'Hardware', salePrice: null, reorderLevel: '10', archived: false, version: 0 };
const page = <T,>(data: T[]) => ({ data, page: { nextCursor: null, limit: 50 } });
const actor = { id: ID('b'), name: 'Asha Verma' };
/** Module screens load lazily and then fetch; allow for a cold start. */
const SLOW = { timeout: 5000 };

const common = {
  'GET /legal-entities': () => Response.json({ data: [entity] }),
  'GET /warehouses': () => Response.json({ data: [MAIN, CITY] }),
  'GET /items': () => Response.json(page([item])),
};

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

const row = { itemId: item.id, sku: item.sku, name: item.name, unitCode: 'NOS', reorderLevel: '10', onHand: '6', reserved: '0', available: '6', inTransit: '4', belowReorder: true };

describe('stock', () => {
  it('shows on-hand, arriving and value, and flags low stock', async () => {
    mockApi({ ...common, 'GET /stock/summary': () => Response.json(page([{ ...row, avgCost: '12.500000', value: '75.00' }])) });
    renderAt('/inventory/stock');
    const table = await screen.findByRole('table', { name: 'Stock on hand in all warehouses you can see' }, SLOW);
    const cells = within(table).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(expect.arrayContaining(['6 NOS', '4', '₹12.50', '₹75.00']));
    expect(within(table).getByText('Low (≤ 10)')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'Hex bolt M8 (sample): stock ledger' }).getAttribute('href')).toContain(`item=${item.id}`);
  });

  it('hides costs from people without cost access', async () => {
    mockApi({ ...common, 'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.storekeeper)), 'GET /stock/summary': () => Response.json(page([row])) });
    renderAt('/inventory/stock');
    const table = await screen.findByRole('table', {}, SLOW);
    expect(within(table).queryByRole('columnheader', { name: 'Value' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Valuation' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Check records' })).toBeNull();
  });

  it('runs the reconciliation check and explains differences', async () => {
    mockApi({
      ...common,
      'GET /stock/summary': () => Response.json(page([row])),
      'GET /stock/reconciliation': () =>
        Response.json({
          checkedAt: '2026-10-20T06:30:00.000Z',
          legalEntityId: ID('e'),
          balancesChecked: 2,
          valuationsChecked: 1,
          ok: false,
          issues: [{ kind: 'on_hand', legalEntityId: ID('e'), warehouseId: MAIN.id, itemId: item.id, sku: item.sku, itemName: item.name, expected: '5', actual: '6' }],
          negativeBalances: [],
        }),
    });
    renderAt('/inventory/stock');
    await userEvent.click(await screen.findByRole('tab', { name: 'Check records' }, SLOW));
    await userEvent.click(screen.getByRole('button', { name: 'Run the check' }));
    expect(await screen.findByText(/1 difference found/)).toBeTruthy();
    expect(screen.getByText('On hand differs from the stock ledger')).toBeTruthy();
    expect(screen.getByText(/BOLT-M8 · Hex bolt M8 \(sample\) · MAIN · ledger 5, recorded 6/)).toBeTruthy();
  });
});

describe('transfers', () => {
  it('drafts a transfer, then dispatches it', async () => {
    const draft = {
      id: ID('f'),
      number: 'TRF-000001',
      status: 'draft',
      legalEntityId: ID('e'),
      fromWarehouseId: MAIN.id,
      fromWarehouseName: 'MAIN · Main godown (sample)',
      toWarehouseId: CITY.id,
      toWarehouseName: 'CITY · City shop (sample)',
      docDate: '2026-10-20',
      note: '',
      lines: [{ lineId: 'l1', itemId: item.id, sku: item.sku, itemName: item.name, unitCode: 'NOS', qty: '4', unitCost: null, value: null }],
      createdBy: actor,
      createdAt: '2026-10-20T06:00:00.000Z',
      dispatchedBy: null,
      dispatchedAt: null,
      receivedBy: null,
      receivedAt: null,
      cancelledAt: null,
      pdf: null,
      version: 0,
    };
    const dispatched = { ...draft, status: 'dispatched', dispatchedBy: actor, dispatchedAt: '2026-10-20T06:05:00.000Z', lines: [{ ...draft.lines[0], unitCost: '12.500000', value: '50.00' }], version: 1 };
    let current: object = draft;
    const calls = mockApi({
      ...common,
      'POST /stock-transfers': () => Response.json(draft, { status: 201 }),
      [`GET /stock-transfers/${ID('f')}`]: () => Response.json(current),
      [`POST /stock-transfers/${ID('f')}/dispatch`]: () => {
        current = dispatched;
        return Response.json(dispatched);
      },
    });
    renderAt('/inventory/transfers/new');
    await userEvent.selectOptions(await screen.findByLabelText(/To warehouse/, {}, SLOW), CITY.id);
    await screen.findByRole('option', { name: /BOLT-M8/ }, SLOW);
    await userEvent.selectOptions(screen.getByLabelText(/^Item 1/), item.id);
    await userEvent.type(screen.getByLabelText(/^Quantity 1/), '4');
    await userEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await screen.findByRole('heading', { level: 1, name: 'Transfer TRF-000001' }, SLOW);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/stock-transfers')?.body).toMatchObject({ fromWarehouseId: MAIN.id, toWarehouseId: CITY.id, lines: [{ itemId: item.id, qty: '4' }] });

    await userEvent.click(screen.getByRole('button', { name: 'Dispatch now' }));
    expect(await screen.findByText('In transit', {}, SLOW)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Receive goods' })).toBeTruthy();
    const dispatch = calls.find((c) => c.path.endsWith('/dispatch'));
    expect(dispatch?.body).toEqual({ version: 0 });
    expect(dispatch?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows the server’s reason when there is not enough stock', async () => {
    const draft = { id: ID('f'), number: 'TRF-000002', status: 'draft', legalEntityId: ID('e'), fromWarehouseId: MAIN.id, fromWarehouseName: 'MAIN', toWarehouseId: CITY.id, toWarehouseName: 'CITY', docDate: '2026-10-20', note: '', lines: [], createdBy: actor, createdAt: '2026-10-20T06:00:00.000Z', dispatchedBy: null, dispatchedAt: null, receivedBy: null, receivedAt: null, cancelledAt: null, pdf: null, version: 0 };
    mockApi({
      ...common,
      [`GET /stock-transfers/${ID('f')}`]: () => Response.json(draft),
      [`POST /stock-transfers/${ID('f')}/dispatch`]: () => error(422, 'INSUFFICIENT_STOCK', 'Not enough stock of BOLT-M8: 3 on hand, 5 needed'),
    });
    renderAt(`/inventory/transfers/${ID('f')}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Dispatch now' }, SLOW));
    expect(await screen.findByText('Not enough stock of BOLT-M8: 3 on hand, 5 needed')).toBeTruthy();
  });
});

describe('opening stock and counts', () => {
  it('enters opening stock with a cost per unit', async () => {
    const calls = mockApi({ ...common, 'POST /stock-adjustments': () => error(400, 'VALIDATION_FAILED', 'Check the highlighted fields', [{ path: 'lines.0.unitCost', message: 'Enter the cost of the opening stock' }]) });
    renderAt('/inventory/adjustments/new?type=opening');
    await screen.findByRole('option', { name: /BOLT-M8/ }, SLOW);
    expect(screen.getByRole('heading', { level: 1, name: 'Enter opening stock' })).toBeTruthy();
    expect(screen.queryByLabelText(/Reason/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/^Item 1/), item.id);
    await userEvent.type(screen.getByLabelText(/^Quantity 1/), '100');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Enter the cost of the opening stock')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ warehouseId: MAIN.id, type: 'opening', reason: null, lines: [{ itemId: item.id, qty: '100', unitCost: null }] });
  });

  it('records counted quantities and only allows submitting once saved', async () => {
    const count = {
      id: ID('c'),
      number: 'CNT-000001',
      status: 'counting',
      legalEntityId: ID('e'),
      warehouseId: MAIN.id,
      warehouseName: 'MAIN · Main godown (sample)',
      note: '',
      scope: 'all',
      snapshotAt: '2026-10-20T06:00:00.000Z',
      lines: [{ lineId: 'l1', itemId: item.id, sku: item.sku, itemName: item.name, unitCode: 'NOS', expectedQty: '20', countedQty: null, variance: null, unitCost: null }],
      countedLines: 0,
      createdBy: actor,
      createdAt: '2026-10-20T06:00:00.000Z',
      postedBy: null,
      postedAt: null,
      version: 1,
    };
    const saved = { ...count, lines: [{ ...count.lines[0], countedQty: '18', variance: '-2' }], countedLines: 1, version: 2 };
    let current: object = count;
    const calls = mockApi({
      ...common,
      [`GET /stock-counts/${ID('c')}`]: () => Response.json(current),
      [`PATCH /stock-counts/${ID('c')}`]: () => {
        current = saved;
        return Response.json(saved);
      },
    });
    renderAt(`/inventory/counts/${ID('c')}`);
    // The table and its stacked small-screen copy are both in the DOM under jsdom; use the table's.
    const table = await screen.findByRole('table', { name: /Count sheet/ }, SLOW);
    const input = within(table).getByRole('textbox', { name: 'Counted quantity of BOLT-M8' });
    await userEvent.type(input, '18');
    expect(screen.getByRole('button', { name: 'Submit count' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Save counts' }));
    expect(await within(await screen.findByRole('table', { name: /Count sheet: 1 of 1/ }, SLOW)).findByText('−2')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ version: 1, lines: [{ itemId: item.id, countedQty: '18', unitCost: null }] });
    expect(screen.getByRole('button', { name: 'Submit count' })).toHaveProperty('disabled', false);
  });
});
