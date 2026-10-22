import { useState } from 'react';
import { createBrowserRouter, createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { TooltipProvider } from '@bizmgmt/ui';
import { PublicOnly, RequireAuth, RequirePendingMfa } from './auth/guards';
import { SessionProvider } from './auth/session';
import { StepUpProvider } from './auth/StepUp';
import { Layout } from './app/Layout';
import { PLANNED_ROUTES } from './app/nav';
import { AcceptInvitePage } from './pages/auth/AcceptInvitePage';
import { LoginPage } from './pages/auth/LoginPage';
import { MfaPage } from './pages/auth/MfaPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/auth/PasswordPages';
import { SignupPage } from './pages/auth/SignupPage';
import { DashboardPage } from './pages/DashboardPage';
import { NotFoundPage, PlannedPage } from './pages/PlannedPage';

/**
 * Module screens load on first visit (route-level code splitting), so the first
 * load carries only the shell, sign-in and dashboard.
 */
const page = <M,>(load: () => Promise<M>, pick: (m: M) => React.ComponentType) => async () => ({ Component: pick(await load()) });
const settings = {
  users: page(() => import('./pages/settings/UsersPage'), (m) => m.UsersPage),
  audit: page(() => import('./pages/settings/AuditPage'), (m) => m.AuditPage),
  company: page(() => import('./pages/settings/CompanyPage'), (m) => m.CompanyPage),
  entity: page(() => import('./pages/settings/CompanyPage'), (m) => m.EntityPage),
  workflow: page(() => import('./pages/settings/WorkflowPage'), (m) => m.WorkflowPage),
  series: page(() => import('./pages/settings/SeriesPage'), (m) => m.SeriesPage),
  tax: page(() => import('./pages/settings/TaxPage'), (m) => m.TaxPage),
  periodLocks: page(() => import('./pages/settings/PeriodLocksPage'), (m) => m.PeriodLocksPage),
};
const catalogue = {
  items: page(() => import('./pages/catalogue/ItemsPage'), (m) => m.ItemsPage),
  item: page(() => import('./pages/catalogue/ItemFormPage'), (m) => m.ItemFormPage),
};
const inventory = {
  stock: page(() => import('./pages/inventory/StockPage'), (m) => m.StockPage),
  warehouses: page(() => import('./pages/inventory/WarehousesPage'), (m) => m.WarehousesPage),
  ledger: page(() => import('./pages/inventory/LedgerPage'), (m) => m.LedgerPage),
  transfers: page(() => import('./pages/inventory/TransfersPage'), (m) => m.TransfersPage),
  transfer: page(() => import('./pages/inventory/TransfersPage'), (m) => m.TransferPage),
  adjustments: page(() => import('./pages/inventory/AdjustmentsPage'), (m) => m.AdjustmentsPage),
  adjustment: page(() => import('./pages/inventory/AdjustmentsPage'), (m) => m.AdjustmentPage),
  count: page(() => import('./pages/inventory/CountsPage'), (m) => m.CountPage),
};
const parties = {
  customers: page(() => import('./pages/parties/PartiesPage'), (m) => () => <m.PartiesPage key="customer" role="customer" />),
  suppliers: page(() => import('./pages/parties/PartiesPage'), (m) => () => <m.PartiesPage key="supplier" role="supplier" />),
  followUps: page(() => import('./pages/parties/Crm'), (m) => m.FollowUpsPage),
  party: page(() => import('./pages/parties/PartyFormPage'), (m) => m.PartyFormPage),
};
const account = page(() => import('./pages/AccountPage'), (m) => m.AccountPage);
const salesList = (type: 'quotation' | 'sales_order' | 'dispatch' | 'sales_invoice') => page(() => import('./pages/sales/SalesPages'), (m) => () => <m.SalesListPage key={type} type={type} />);
const salesDoc = (type: 'quotation' | 'sales_order' | 'dispatch' | 'sales_invoice') => page(() => import('./pages/sales/SalesPages'), (m) => () => <m.SalesDocPage key={type} type={type} />);
const receivables = page(() => import('./pages/sales/ReceivablesPage'), (m) => m.ReceivablesPage);
const purchases = {
  orders: page(() => import('./pages/purchases/PurchaseOrdersPage'), (m) => m.PurchaseOrdersListPage),
  order: page(() => import('./pages/purchases/PurchaseOrdersPage'), (m) => m.PurchaseOrderDocPage),
  receipts: page(() => import('./pages/purchases/GoodsReceiptsPage'), (m) => m.GoodsReceiptsListPage),
  receipt: page(() => import('./pages/purchases/GoodsReceiptsPage'), (m) => m.GoodsReceiptDocPage),
  bills: page(() => import('./pages/purchases/SupplierBillsPage'), (m) => m.SupplierBillsListPage),
  bill: page(() => import('./pages/purchases/SupplierBillsPage'), (m) => m.SupplierBillDocPage),
  payables: page(() => import('./pages/purchases/PayablesPage'), (m) => m.PayablesPage),
};
const moneyPages = {
  receipts: page(() => import('./pages/money/PaymentsPage'), (m) => () => <m.PaymentsPage key="incoming" direction="incoming" />),
  payments: page(() => import('./pages/money/PaymentsPage'), (m) => () => <m.PaymentsPage key="outgoing" direction="outgoing" />),
  expenses: page(() => import('./pages/money/ExpensesPage'), (m) => m.ExpensesPage),
};
const creditNotes = page(() => import('./pages/sales/CreditNotesPage'), (m) => m.CreditNotesPage);
const debitNotes = page(() => import('./pages/purchases/DebitNotesPage'), (m) => m.DebitNotesPage);
const partyStatement = page(() => import('./pages/reports/PartyStatementPage'), (m) => m.PartyStatementPage);
const reports = {
  reconciliation: page(() => import('./pages/reports/FinancialReconciliationPage'), (m) => m.FinancialReconciliationPage),
  compliance: page(() => import('./pages/reports/ComplianceCapabilitiesPage'), (m) => m.ComplianceCapabilitiesPage),
  outwardRegister: page(() => import('./pages/reports/OutwardRegisterPage'), (m) => m.OutwardRegisterPage),
  purchaseRegister: page(() => import('./pages/reports/PurchaseRegisterPage'), (m) => m.PurchaseRegisterPage),
  hsnSummary: page(() => import('./pages/reports/HsnSummaryPage'), (m) => m.HsnSummaryPage),
  documentSummary: page(() => import('./pages/reports/DocumentSummaryPage'), (m) => m.DocumentSummaryPage),
};

function Root() {
  return (
    <SessionProvider>
      <StepUpProvider>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </StepUpProvider>
    </SessionProvider>
  );
}

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      {
        element: <PublicOnly />,
        children: [
          { path: 'login', element: <LoginPage /> },
          { path: 'signup', element: <SignupPage /> },
          { path: 'forgot-password', element: <ForgotPasswordPage /> },
        ],
      },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      { path: 'accept-invite', element: <AcceptInvitePage /> },
      {
        path: 'mfa',
        element: (
          <RequirePendingMfa>
            <MfaPage />
          </RequirePendingMfa>
        ),
      },
      {
        path: '/',
        element: (
          <RequireAuth>
            <Layout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'settings/users', lazy: settings.users },
          { path: 'settings/company', lazy: settings.company },
          { path: 'settings/company/:id', lazy: settings.entity },
          { path: 'settings/workflow', lazy: settings.workflow },
          { path: 'settings/series', lazy: settings.series },
          { path: 'settings/tax', lazy: settings.tax },
          { path: 'settings/audit', lazy: settings.audit },
          { path: 'settings/period-locks', lazy: settings.periodLocks },
          { path: 'inventory/items', lazy: catalogue.items },
          { path: 'inventory/items/:id', lazy: catalogue.item },
          { path: 'inventory/stock', lazy: inventory.stock },
          { path: 'inventory/warehouses', lazy: inventory.warehouses },
          { path: 'inventory/ledger', lazy: inventory.ledger },
          { path: 'inventory/transfers', lazy: inventory.transfers },
          { path: 'inventory/transfers/:id', lazy: inventory.transfer },
          { path: 'inventory/adjustments', lazy: inventory.adjustments },
          { path: 'inventory/adjustments/:id', lazy: inventory.adjustment },
          { path: 'inventory/counts/:id', lazy: inventory.count },
          { path: 'parties/customers', lazy: parties.customers },
          { path: 'parties/suppliers', lazy: parties.suppliers },
          { path: 'parties/follow-ups', lazy: parties.followUps },
          { path: 'parties/:id', lazy: parties.party },
          { path: 'sales/quotations', lazy: salesList('quotation') },
          { path: 'sales/quotations/:id', lazy: salesDoc('quotation') },
          { path: 'sales/orders', lazy: salesList('sales_order') },
          { path: 'sales/orders/:id', lazy: salesDoc('sales_order') },
          { path: 'sales/dispatches', lazy: salesList('dispatch') },
          { path: 'sales/dispatches/:id', lazy: salesDoc('dispatch') },
          { path: 'sales/invoices', lazy: salesList('sales_invoice') },
          { path: 'sales/invoices/:id', lazy: salesDoc('sales_invoice') },
          { path: 'purchases/orders', lazy: purchases.orders },
          { path: 'purchases/orders/:id', lazy: purchases.order },
          { path: 'purchases/receipts', lazy: purchases.receipts },
          { path: 'purchases/receipts/:id', lazy: purchases.receipt },
          { path: 'purchases/bills', lazy: purchases.bills },
          { path: 'purchases/bills/:id', lazy: purchases.bill },
          { path: 'purchases/payables', lazy: purchases.payables },
          { path: 'money/receipts', lazy: moneyPages.receipts },
          { path: 'money/payments', lazy: moneyPages.payments },
          { path: 'money/expenses', lazy: moneyPages.expenses },
          { path: 'sales/credit-notes', lazy: creditNotes },
          { path: 'sales/returns', lazy: creditNotes },
          { path: 'purchases/debit-notes', lazy: debitNotes },
          { path: 'purchases/returns', lazy: debitNotes },
          { path: 'reports/reconciliation', lazy: reports.reconciliation },
          { path: 'reports/compliance', lazy: reports.compliance },
          { path: 'reports/outward-register', lazy: reports.outwardRegister },
          { path: 'reports/purchase-register', lazy: reports.purchaseRegister },
          { path: 'reports/hsn-summary', lazy: reports.hsnSummary },
          { path: 'reports/document-summary', lazy: reports.documentSummary },
          { path: 'reports/ageing', lazy: receivables },
          { path: 'reports/statements', lazy: partyStatement },
          { path: 'account', lazy: account },
          ...PLANNED_ROUTES.map((route) => ({ path: route.path.slice(1), element: <PlannedPage route={route} /> })),
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export function App() {
  const [router] = useState(() => createBrowserRouter(routes));
  return <RouterProvider router={router} />;
}

/** In-memory router for tests. */
export function TestApp({ path = '/' }: { path?: string }) {
  return <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />;
}
