import { BarChart3, Boxes, LayoutDashboard, Settings, ShoppingCart, Users, Wallet, Receipt } from 'lucide-react';
import type { NavGroup } from '@bizmgmt/ui';

/** A route for a module that is specified but not built yet. */
export interface PlannedRoute {
  path: string;
  title: string;
  /** Roadmap phase that delivers it (docs/planning/roadmap.md). */
  phase: number;
  description: string;
}

const icon = { size: 18, strokeWidth: 2 } as const;

// Navigation map: docs/design/design-system.md §5.
export const NAV: NavGroup[] = [
  { label: 'Dashboard', to: '/', icon: <LayoutDashboard {...icon} /> },
  {
    label: 'Sales',
    to: '/sales/invoices',
    icon: <Receipt {...icon} />,
    items: [
      { label: 'Quotations', to: '/sales/quotations' },
      { label: 'Sales orders', to: '/sales/orders' },
      { label: 'Dispatches', to: '/sales/dispatches' },
      { label: 'Invoices', to: '/sales/invoices' },
      { label: 'Credit notes', to: '/sales/credit-notes' },
      { label: 'Sales returns', to: '/sales/returns' },
    ],
  },
  {
    label: 'Purchases',
    to: '/purchases/bills',
    icon: <ShoppingCart {...icon} />,
    items: [
      { label: 'Purchase orders', to: '/purchases/orders' },
      { label: 'Goods receipts', to: '/purchases/receipts' },
      { label: 'Supplier bills', to: '/purchases/bills' },
      { label: 'Debit notes', to: '/purchases/debit-notes' },
      { label: 'Purchase returns', to: '/purchases/returns' },
    ],
  },
  {
    label: 'Inventory',
    to: '/inventory/stock',
    icon: <Boxes {...icon} />,
    items: [
      { label: 'Stock', to: '/inventory/stock' },
      { label: 'Items', to: '/inventory/items' },
      { label: 'Warehouses', to: '/inventory/warehouses' },
      { label: 'Stock ledger', to: '/inventory/ledger' },
      { label: 'Transfers', to: '/inventory/transfers' },
      { label: 'Adjustments & counts', to: '/inventory/adjustments' },
    ],
  },
  {
    label: 'Parties',
    to: '/parties/customers',
    icon: <Users {...icon} />,
    items: [
      { label: 'Customers', to: '/parties/customers' },
      { label: 'Suppliers', to: '/parties/suppliers' },
      { label: 'Follow-ups', to: '/parties/follow-ups' },
    ],
  },
  {
    label: 'Money',
    to: '/money/receipts',
    icon: <Wallet {...icon} />,
    items: [
      { label: 'Receipts', to: '/money/receipts' },
      { label: 'Payments', to: '/money/payments' },
      { label: 'Expenses', to: '/money/expenses' },
    ],
  },
  {
    label: 'Reports',
    to: '/reports/registers',
    icon: <BarChart3 {...icon} />,
    items: [
      { label: 'Registers', to: '/reports/registers' },
      { label: 'Outstanding & ageing', to: '/reports/ageing' },
      { label: 'Party statements', to: '/reports/statements' },
      { label: 'GST summary', to: '/reports/gst' },
      { label: 'Ledgers', to: '/reports/ledgers' },
    ],
  },
  {
    label: 'Settings',
    to: '/settings/company',
    icon: <Settings {...icon} />,
    items: [
      { label: 'Company & GST', to: '/settings/company' },
      { label: 'Document series', to: '/settings/series' },
      { label: 'Tax rates', to: '/settings/tax' },
      { label: 'Users & roles', to: '/settings/users' },
      { label: 'Workflow', to: '/settings/workflow' },
      { label: 'Period locks', to: '/settings/period-locks' },
      { label: 'Audit log', to: '/settings/audit' },
    ],
  },
];

const PHASE_BY_PREFIX: Array<[string, number, string]> = [
  ['/reports/registers', 11, 'Sales and purchase registers.'],
  ['/reports/gst', 11, 'HSN-wise and rate-wise GST summaries.'],
  ['/reports/ledgers', 11, 'Party and stock ledgers.'],
];

export const PLANNED_ROUTES: PlannedRoute[] = PHASE_BY_PREFIX.map(([path, phase, description]) => {
  const title = NAV.flatMap((g) => g.items ?? []).find((i) => i.to === path)?.label ?? path;
  return { path, phase, description, title };
});
