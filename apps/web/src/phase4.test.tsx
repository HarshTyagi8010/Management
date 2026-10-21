import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gstinCheckCharacter, SYSTEM_ROLE_PERMISSIONS } from '@bizmgmt/contracts';
import { TestApp } from './App';
import { apiState } from './lib/api';
import { error, mockApi, tenantContext } from './test-api';

const ID = (c: string) => c.repeat(24);
const PAN = 'ZZZCD0001Z';
const gstin = (state: string, pan = PAN) => `${state}${pan}1Z` + gstinCheckCharacter(`${state}${pan}1Z`);
const address = { line1: '1 Sample Estate', line2: '', city: 'Mumbai', district: '', stateCode: '27', pincode: '400001' };
const entity = {
  id: ID('e'),
  legalName: 'Demo Traders Private Limited (sample)',
  tradeName: '',
  pan: PAN,
  constitution: 'private_limited',
  address,
  email: '',
  phone: '',
  fyStartMonth: 4,
  turnoverBand: 'above_5cr_below_10cr',
  workflow: { stockOutPoint: 'dispatch', stockInPoint: 'goods_receipt', allowNegativeStock: false, roundOffTotal: true },
  periodLockDate: null,
  bankAccounts: [],
  registrationCount: 1,
  logo: null,
  archived: false,
  version: 3,
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

describe('company & GST', () => {
  it('guides a new business to add its entity', async () => {
    const calls = mockApi({
      'GET /legal-entities': () => Response.json({ data: [] }),
      'POST /legal-entities': () => Response.json({ ...entity, registrationCount: 0 }, { status: 201 }),
      [`GET /legal-entities/${ID('e')}`]: () => Response.json({ ...entity, registrationCount: 0 }),
      [`GET /legal-entities/${ID('e')}/registrations`]: () => Response.json({ data: [] }),
    });
    renderAt('/settings/company');
    expect(await screen.findByText('Add your business entity')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Add business entity' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add business entity' });
    await userEvent.type(within(dialog).getByLabelText(/Legal name/), entity.legalName);
    await userEvent.type(within(dialog).getByLabelText(/^PAN/), 'zzzcd0001z');
    await userEvent.type(within(dialog).getByLabelText(/Address line 1/), address.line1);
    await userEvent.type(within(dialog).getByLabelText(/City or town/), address.city);
    await userEvent.selectOptions(within(dialog).getByLabelText(/^State/), '27');
    await userEvent.type(within(dialog).getByLabelText(/PIN code/), address.pincode);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add business entity' }));
    await screen.findByRole('heading', { level: 1, name: entity.legalName });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/legal-entities');
    expect(post?.body).toMatchObject({ legalName: entity.legalName, pan: PAN, address: { stateCode: '27', pincode: '400001' } });
  });

  it('checks a GSTIN in the browser before sending it, and explains e-invoice limits', async () => {
    mockApi({
      [`GET /legal-entities/${ID('e')}`]: () => Response.json(entity),
      [`GET /legal-entities/${ID('e')}/registrations`]: () => Response.json({ data: [] }),
    });
    renderAt(`/settings/company/${ID('e')}`);
    expect(await screen.findByText(/does not generate e-invoices/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add GSTIN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add GST registration' });
    const valid = gstin('29');
    const typo = valid.slice(0, 14) + (valid.endsWith('A') ? 'B' : 'A');
    await userEvent.type(within(dialog).getByLabelText(/^GSTIN/), typo);
    expect(within(dialog).getByText(/check character/)).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText(/^GSTIN/));
    await userEvent.type(within(dialog).getByLabelText(/^GSTIN/), gstin('29', 'ZZZCE0002Z'));
    expect(within(dialog).getByText(/contains PAN ZZZCE0002Z/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Add registration' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('document series', () => {
  it('previews the number and refuses formats over 16 characters', async () => {
    mockApi({
      'GET /legal-entities': () => Response.json({ data: [entity] }),
      'GET /document-series': () => Response.json({ data: [] }),
      [`GET /legal-entities/${ID('e')}/registrations`]: () =>
        Response.json({ data: [{ id: ID('1'), legalEntityId: ID('e'), gstin: gstin('27'), stateCode: '27', registrationType: 'regular', effectiveFrom: '2017-07-01', effectiveTo: null, address, label: '', version: 0 }] }),
    });
    renderAt('/settings/series');
    await userEvent.click(await screen.findByRole('button', { name: 'Add series' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add document series' });
    expect(within(dialog).getByText(/First number:/).textContent).toMatch(/INV\/\d{2}-\d{2}\/0001 \(14 of 16 characters\)/);
    const prefix = within(dialog).getByLabelText(/Prefix/);
    await userEvent.clear(prefix);
    // In user-event, "{{" types a literal "{".
    await userEvent.type(prefix, 'INVOICES{{FY}/X');
    expect(within(dialog).getByText(/can't fit in 16 characters/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save series' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('items and cost visibility (FR-RBAC-04)', () => {
  const item = {
    id: ID('2'),
    sku: 'SMP-BOLT',
    name: 'Sample bolt',
    description: '',
    type: 'stock',
    categoryId: null,
    categoryName: null,
    baseUnitId: ID('3'),
    baseUnitCode: 'PCS',
    altUnits: [],
    hsnSac: '7318',
    taxClassId: ID('4'),
    taxClassName: 'Sample goods',
    salePrice: '4.50',
    reorderLevel: null,
    archived: false,
    version: 0,
  };

  it('shows no cost column without price.view_cost', async () => {
    mockApi({
      'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.sales)),
      'GET /items': () => Response.json({ data: [item], page: { nextCursor: null, limit: 50 } }),
    });
    renderAt('/inventory/items');
    expect((await screen.findAllByText('Sample bolt')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Cost')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add item' })).toBeNull();
    expect(screen.getAllByText('₹4.50').length).toBeGreaterThan(0);
  });

  it('lets the Purchase role edit items but not prices', async () => {
    mockApi({
      'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.purchase)),
      [`GET /items/${ID('2')}`]: () => Response.json({ ...item, purchasePrice: '3.10' }),
      'GET /units': () => Response.json({ data: [{ id: ID('3'), code: 'PCS', name: 'Pieces', uqc: 'PCS', decimals: 0, archived: false, version: 0 }] }),
      'GET /tax-classes': () => Response.json({ data: [] }),
      'GET /categories': () => Response.json({ data: [] }),
    });
    renderAt(`/inventory/items/${ID('2')}`);
    await screen.findByRole('heading', { level: 1, name: 'Sample bolt' });
    expect((screen.getByLabelText(/Sale price/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Purchase price/) as HTMLInputElement).value).toBe('3.10');
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/needs the “Change prices” permission/)).toBeTruthy();
  });
});

describe('parties', () => {
  it('warns about possible duplicates and saves only when confirmed', async () => {
    let attempts = 0;
    const calls = mockApi({
      'POST /parties': (call) => {
        attempts += 1;
        if (!(call.body as { confirmDuplicates: boolean }).confirmDuplicates) {
          return error(409, 'DUPLICATE', 'This looks like a party you already have.', [{ path: `duplicate.${ID('5')}`, message: 'Sample Buyers has the same PAN' }]);
        }
        return Response.json({ id: ID('6'), name: 'Sample Buyers 2', legalName: '', isCustomer: true, isSupplier: false, addresses: [], pan: PAN, gstins: [], contacts: [], creditLimit: null, paymentTermsDays: null, tags: [], archived: false, version: 0 }, { status: 201 });
      },
      [`GET /parties/${ID('6')}`]: () => Response.json({ id: ID('6'), name: 'Sample Buyers 2', legalName: '', isCustomer: true, isSupplier: false, addresses: [], pan: PAN, gstins: [], contacts: [], creditLimit: null, paymentTermsDays: null, tags: [], archived: false, version: 0 }),
      [`GET /parties/${ID('6')}/timeline`]: () => Response.json({ data: [] }),
    });
    renderAt('/parties/new?role=customer');
    await screen.findByRole('heading', { level: 1, name: 'Add customer' });
    await userEvent.type(screen.getByLabelText(/^Name/), 'Sample Buyers 2');
    await userEvent.type(screen.getByLabelText(/^PAN/), PAN);
    await userEvent.type(screen.getByLabelText(/Address line 1/), address.line1);
    await userEvent.type(screen.getByLabelText(/City or town/), address.city);
    await userEvent.selectOptions(screen.getByLabelText(/^State/), '27');
    await userEvent.type(screen.getByLabelText(/PIN code/), address.pincode);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Sample Buyers has the same PAN')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'It’s different, save anyway' }));
    await screen.findByRole('heading', { level: 1, name: 'Sample Buyers 2' });
    expect(attempts).toBe(2);
    expect(calls.filter((c) => c.path === '/parties' && c.method === 'POST').map((c) => (c.body as { confirmDuplicates: boolean }).confirmDuplicates)).toEqual([false, true]);
  });

  it('fills the PAN from the first valid GSTIN', async () => {
    mockApi();
    renderAt('/parties/new?role=supplier');
    await screen.findByRole('heading', { level: 1, name: 'Add supplier' });
    await userEvent.click(screen.getByRole('button', { name: 'Add GSTIN' }));
    await userEvent.type(screen.getByLabelText(/^GSTIN 1/), gstin('24'));
    expect((screen.getByLabelText(/^PAN/) as HTMLInputElement).value).toBe(PAN);
  });

  it('shows storekeepers names and places only', async () => {
    mockApi({
      'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.storekeeper)),
      'GET /parties': () => Response.json({ data: [{ id: ID('5'), name: 'Sample Buyers', legalName: '', isCustomer: true, isSupplier: false, addresses: [{ id: 'a', label: '', isBilling: true, isShipping: true, ...address }], archived: false, version: 0 }], page: { nextCursor: null, limit: 50 } }),
    });
    renderAt('/parties/customers');
    expect((await screen.findAllByText('Sample Buyers')).length).toBeGreaterThan(0);
    expect(screen.queryByText('GSTIN')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sample Buyers' })).toBeNull();
  });
});

describe('tax rates', () => {
  it('flags classes with no rate for today and requires a source for new rates', async () => {
    const taxClass = { id: ID('4'), name: 'Sample goods', kind: 'goods', treatment: 'taxable', reverseCharge: false, description: '', schedules: [], currentRate: null, archived: false, version: 0 };
    const calls = mockApi({
      'GET /tax-classes': () => Response.json({ data: [taxClass] }),
      [`POST /tax-classes/${ID('4')}/schedules`]: () => Response.json({ ...taxClass, version: 1 }, { status: 201 }),
    });
    renderAt('/settings/tax');
    expect((await screen.findAllByText('No rate for today')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole('button', { name: 'Manage rates for Sample goods' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Rates for Sample goods' });
    await userEvent.type(within(dialog).getByLabelText(/GST rate/), '18');
    await userEvent.type(within(dialog).getByLabelText(/Effective from/), '2025-09-22');
    const add = within(dialog).getByRole('button', { name: 'Add rate' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText(/^Source/), 'Synthetic test source');
    await userEvent.click(add);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/schedules'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/schedules'))?.body).toMatchObject({ gstRate: '18', effectiveFrom: '2025-09-22', sourceReference: 'Synthetic test source', cessRate: null });
  });
});
