/**
 * SAMPLE DATA ONLY. Fictional figures used to lay out the dashboard before the
 * reporting APIs exist (Phase 11). Every screen using this data shows a visible
 * "Sample data" notice. Money is kept as decimal strings, exactly as the API will send it.
 */

export const SAMPLE_AS_OF = '2026-10-19';

export interface Kpi {
  key: 'sales' | 'purchases' | 'receivables' | 'payables' | 'inventory';
  label: string;
  value: string;
  definition: string;
}

// Definitions follow docs/architecture/financial-policy.md §9.
export const SAMPLE_KPIS: Kpi[] = [
  {
    key: 'sales',
    label: 'Sales (October)',
    value: '1845320.00',
    definition: 'Taxable value of issued sales invoices minus credit notes this month, excluding GST.',
  },
  {
    key: 'purchases',
    label: 'Purchases (October)',
    value: '1236780.50',
    definition: 'Taxable value of posted supplier bills minus debit notes this month, excluding GST.',
  },
  {
    key: 'receivables',
    label: 'Receivables',
    value: '962450.00',
    definition: 'Outstanding on issued invoices and debit notes, less unallocated receipts and advances.',
  },
  {
    key: 'payables',
    label: 'Payables',
    value: '418900.75',
    definition: 'Outstanding on posted supplier bills, less unallocated payments and advances.',
  },
  {
    key: 'inventory',
    label: 'Inventory value',
    value: '3120560.40',
    definition: 'On-hand quantity × moving weighted-average cost across all warehouses.',
  },
];

export interface MonthPoint {
  month: string; // "2026-05"
  label: string; // "May"
  sales: string;
  purchases: string;
}

export const SAMPLE_MONTHLY: MonthPoint[] = [
  { month: '2026-05', label: 'May', sales: '1420500.00', purchases: '1102300.00' },
  { month: '2026-06', label: 'Jun', sales: '1385200.00', purchases: '980450.00' },
  { month: '2026-07', label: 'Jul', sales: '1610800.00', purchases: '1254100.00' },
  { month: '2026-08', label: 'Aug', sales: '1702400.00', purchases: '1190750.00' },
  { month: '2026-09', label: 'Sep', sales: '1950300.00', purchases: '1388200.00' },
  { month: '2026-10', label: 'Oct', sales: '1845320.00', purchases: '1236780.50' },
];

export type EventKind = 'payment_due' | 'po_expected' | 'task';

export interface BusinessEvent {
  id: string;
  date: string;
  kind: EventKind;
  title: string;
  party: string;
  amount?: string;
  overdue?: boolean;
}

export const SAMPLE_EVENTS: BusinessEvent[] = [
  { id: 'e1', date: '2026-10-17', kind: 'payment_due', title: 'INV/26-27/0412 due', party: 'Shree Ganesh Hardware', amount: '84500.00', overdue: true },
  { id: 'e2', date: '2026-10-19', kind: 'task', title: 'Call about pending order', party: 'Patel Auto Spares', },
  { id: 'e3', date: '2026-10-19', kind: 'payment_due', title: 'INV/26-27/0431 due', party: 'Kaveri Distributors', amount: '126000.00' },
  { id: 'e4', date: '2026-10-20', kind: 'po_expected', title: 'PO/26-27/0088 delivery', party: 'Om Steel Industries' },
  { id: 'e5', date: '2026-10-22', kind: 'payment_due', title: 'INV/26-27/0440 due', party: 'Sai Electricals', amount: '45250.00' },
  { id: 'e6', date: '2026-10-23', kind: 'task', title: 'Send revised quotation', party: 'Metro Workshop', },
  { id: 'e7', date: '2026-10-24', kind: 'po_expected', title: 'PO/26-27/0091 delivery', party: 'Bharat Packaging' },
];

export type ActivityKind = 'invoice_issued' | 'receipt_posted' | 'bill_posted' | 'stock_adjusted' | 'quotation_sent';

export interface Activity {
  id: string;
  at: string; // ISO timestamp
  kind: ActivityKind;
  text: string;
  actor: string;
  amount?: string;
}

export const SAMPLE_ACTIVITY: Activity[] = [
  { id: 'a1', at: '2026-10-19T11:42:00+05:30', kind: 'invoice_issued', text: 'Invoice INV/26-27/0452 issued to Kaveri Distributors', actor: 'Asha (Accounts)', amount: '58410.00' },
  { id: 'a2', at: '2026-10-19T10:15:00+05:30', kind: 'receipt_posted', text: 'Receipt RCT/26-27/0210 from Sai Electricals allocated to 2 invoices', actor: 'Asha (Accounts)', amount: '40000.00' },
  { id: 'a3', at: '2026-10-18T17:05:00+05:30', kind: 'stock_adjusted', text: 'Stock count posted at Main Godown (3 variances)', actor: 'Ravi (Stores)' },
  { id: 'a4', at: '2026-10-18T15:30:00+05:30', kind: 'bill_posted', text: 'Supplier bill OSI/1189 from Om Steel Industries posted', actor: 'Imran (Purchase)', amount: '212300.00' },
  { id: 'a5', at: '2026-10-18T12:10:00+05:30', kind: 'quotation_sent', text: 'Quotation QTN/26-27/0127 sent to Metro Workshop', actor: 'Neha (Sales)', amount: '96800.00' },
];

export interface OverdueInvoice {
  id: string;
  number: string;
  party: string;
  dueDate: string;
  daysOverdue: number;
  outstanding: string;
}

export const SAMPLE_OVERDUE: OverdueInvoice[] = [
  { id: 'o1', number: 'INV/26-27/0412', party: 'Shree Ganesh Hardware', dueDate: '2026-10-17', daysOverdue: 2, outstanding: '84500.00' },
  { id: 'o2', number: 'INV/26-27/0377', party: 'Patel Auto Spares', dueDate: '2026-10-02', daysOverdue: 17, outstanding: '152340.00' },
  { id: 'o3', number: 'INV/26-27/0351', party: 'Metro Workshop', dueDate: '2026-09-20', daysOverdue: 29, outstanding: '38900.00' },
  { id: 'o4', number: 'INV/26-27/0298', party: 'Lakshmi Traders', dueDate: '2026-08-28', daysOverdue: 52, outstanding: '210000.00' },
];
