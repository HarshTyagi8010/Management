import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FinancialReconciliationResponse } from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  PermissionDenied,
  Select,
  Skeleton,
  StatusBadge,
  formatINR,
  type StatusTone,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function FinancialReconciliationPage() {
  usePageTitle('Financial Reconciliation');
  const { can } = useSession();
  const entities = useLegalEntities();
  const allowed = entities.data ?? [];

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';

  const [mode, setMode] = useState<'current' | 'historical'>('current');
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));

  const hasPermission = can('report.financial');

  const queryKey = useTenantQueryKey('reconciliation', 'financial', chosenEntity, mode, mode === 'historical' ? asOfDate : 'now');
  const reconQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        legalEntityId: chosenEntity,
        mode,
        drillDown: 'true',
      });
      if (mode === 'historical' && asOfDate) {
        params.set('asOfDate', asOfDate);
      }
      return api<FinancialReconciliationResponse>(`/reconciliation/financial?${params.toString()}`, { signal });
    },
    enabled: Boolean(chosenEntity && hasPermission),
  });

  if (!hasPermission) {
    return <PermissionDenied permission="report.financial" />;
  }

  const recon = reconQuery.data;

  const getStatusTone = (status: string): StatusTone => {
    switch (status) {
      case 'MATCHED':
        return 'success';
      case 'MISMATCH':
        return 'danger';
      case 'INCOMPLETE':
        return 'warning';
      case 'UNSUPPORTED':
        return 'neutral';
      default:
        return 'neutral';
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Authoritative Financial Reconciliation"
        description="Independent cross-verification between General Ledger control accounts and operational subledgers across AR, AP, Advances, Inventory, Taxes, and Journals."
      />

      {/* Scope and Capability Disclosure */}
      <div className="rounded-md border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
        <p className="font-semibold">Statutory & Historical Capability Boundaries</p>
        <p className="mt-1 text-xs">
          Scope currency: <strong>INR (₹)</strong>. Current-state reconciliation cross-verifies live ledger accounts against operational subledgers.
          Historical point-in-time retrospective verification is unsupported for mutable ledgers where subsequent postings exist. Current-state reconciliation does not certify past closing balances.
        </p>
      </div>

      {/* Filter Toolbar */}
      <Card>
        <CardBody className="flex flex-wrap items-end gap-4">
          <div className="w-64">
            <FormField label="Business Entity">
              {(f) => (
                <Select
                  {...f}
                  value={chosenEntity}
                  onChange={(e) => setSelectedEntityId(e.target.value)}
                  disabled={reconQuery.isFetching}
                >
                  {allowed.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.legalName} ({e.pan})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </div>

          <div className="w-48">
            <FormField label="Reconciliation Mode">
              {(f) => (
                <Select
                  {...f}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as 'current' | 'historical')}
                  disabled={reconQuery.isFetching}
                >
                  <option value="current">Current Live State</option>
                  <option value="historical">Historical As-Of Date</option>
                </Select>
              )}
            </FormField>
          </div>

          {mode === 'historical' && (
            <div className="w-44">
              <FormField label="As of Date">
                {(f) => (
                  <Input
                    {...f}
                    type="date"
                    value={asOfDate}
                    onChange={(e) => setAsOfDate(e.target.value)}
                    disabled={reconQuery.isFetching}
                  />
                )}
              </FormField>
            </div>
          )}

          <Button
            variant="secondary"
            onClick={() => void reconQuery.refetch()}
            disabled={reconQuery.isFetching}
          >
            {reconQuery.isFetching ? 'Reconciling…' : 'Refresh State'}
          </Button>
        </CardBody>
      </Card>

      {/* Loading / Error States */}
      {reconQuery.isPending && (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {reconQuery.isError && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-4 text-xs text-rose-800">
          Reconciliation request failed: {errorMessage(reconQuery.error)}
        </div>
      )}

      {/* Reconciliation Content */}
      {recon && (
        <div className="space-y-6">
          {/* Status Metric Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <p className="text-xs font-medium text-muted">Overall Status</p>
              <div className="mt-1">
                <StatusBadge label={recon.status} tone={getStatusTone(recon.status)} />
              </div>
              <p className="mt-2 text-xs text-muted">At {new Date(recon.generatedAt).toLocaleTimeString()}</p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <p className="text-xs font-medium text-muted">Sections Matched</p>
              <p className="mt-1 text-2xl font-bold">{recon.summary.matchedSections} / {recon.summary.totalSections}</p>
              <p className="mt-1 text-xs text-muted">Control sections verified</p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <p className="text-xs font-medium text-muted">Mismatched Sections</p>
              <p className="mt-1 text-2xl font-bold text-rose-600">{recon.summary.mismatchedSections}</p>
              <p className="mt-1 text-xs text-muted">{recon.summary.mismatchedSections > 0 ? 'Discrepancy detected' : 'Zero discrepancies'}</p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <p className="text-xs font-medium text-muted">Incomplete Sections</p>
              <p className="mt-1 text-2xl font-bold text-amber-600">{recon.summary.incompleteSections}</p>
              <p className="mt-1 text-xs text-muted">{recon.summary.emptyDataset ? 'Empty ledger state' : 'No activity'}</p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <p className="text-xs font-medium text-muted">Unsupported Sections</p>
              <p className="mt-1 text-2xl font-bold text-muted">{recon.summary.unsupportedSections}</p>
              <p className="mt-1 text-xs text-muted">{mode === 'historical' ? 'Historical point-in-time' : 'None'}</p>
            </div>
          </div>

          {/* Detailed Condition Notice if Incomplete or Unsupported */}
          {recon.unsupportedConditions.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">Reconciliation Scope Disclosures:</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {recon.unsupportedConditions.map((cond, idx) => (
                  <li key={idx}>{cond}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Section 1: Journal Integrity */}
          <Card>
            <CardHeader
              title="1. General Ledger Journal Integrity"
              description="Verifies double-entry arithmetic balance (debits = credits) and checks for missing or orphaned postings."
            />
            <CardBody>
              <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
                <div className="flex gap-6 text-sm">
                  <div>Checked: <span className="font-semibold">{recon.sections.journalIntegrity.journalsChecked}</span></div>
                  <div>Balanced: <span className="font-semibold text-emerald-600">{recon.sections.journalIntegrity.balancedJournals}</span></div>
                  <div>Unbalanced: <span className={`font-semibold ${recon.sections.journalIntegrity.unbalancedJournals > 0 ? 'text-rose-600' : ''}`}>{recon.sections.journalIntegrity.unbalancedJournals}</span></div>
                  <div>Missing Postings: <span className={`font-semibold ${recon.sections.journalIntegrity.missingPostings > 0 ? 'text-rose-600' : ''}`}>{recon.sections.journalIntegrity.missingPostings}</span></div>
                </div>
                <StatusBadge label={recon.sections.journalIntegrity.status} tone={getStatusTone(recon.sections.journalIntegrity.status)} />
              </div>

              {recon.sections.journalIntegrity.issues.length > 0 && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-semibold text-rose-700">Integrity Issues Found:</p>
                  <ul className="list-disc pl-5 text-xs text-rose-600">
                    {recon.sections.journalIntegrity.issues.map((iss, i) => (
                      <li key={i}>{iss.kind}: {iss.detail}</li>
                    ))}
                  </ul>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Section 2: Accounts Receivable */}
          <Card>
            <CardHeader
              title="2. Trade Receivables (GL 1200)"
              description="Reconciles customer unpaid invoice balances against General Ledger Account 1200 (Accounts Receivable)."
            />
            <CardBody>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 border-b pb-4 text-sm">
                <div>Subledger AR Balance: <span className="font-bold tabular">{formatINR(recon.sections.tradeReceivables.subledgerBalance)}</span></div>
                <div>GL 1200 Balance: <span className="font-bold tabular">{formatINR(recon.sections.tradeReceivables.glBalance)}</span></div>
                <div>Difference: <span className={`font-bold tabular ${parseFloat(recon.sections.tradeReceivables.difference) !== 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatINR(recon.sections.tradeReceivables.difference)}</span></div>
                <div className="text-right"><StatusBadge label={recon.sections.tradeReceivables.status} tone={getStatusTone(recon.sections.tradeReceivables.status)} /></div>
              </div>
            </CardBody>
          </Card>

          {/* Section 3: Accounts Payable */}
          <Card>
            <CardHeader
              title="3. Trade Payables (GL 2100)"
              description="Reconciles supplier unpaid bill balances and accrued expenses against General Ledger Account 2100 (Accounts Payable)."
            />
            <CardBody>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 border-b pb-4 text-sm">
                <div>Subledger AP Balance: <span className="font-bold tabular">{formatINR(recon.sections.tradePayables.subledgerBalance)}</span></div>
                <div>GL 2100 Balance: <span className="font-bold tabular">{formatINR(recon.sections.tradePayables.glBalance)}</span></div>
                <div>Difference: <span className={`font-bold tabular ${parseFloat(recon.sections.tradePayables.difference) !== 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatINR(recon.sections.tradePayables.difference)}</span></div>
                <div className="text-right"><StatusBadge label={recon.sections.tradePayables.status} tone={getStatusTone(recon.sections.tradePayables.status)} /></div>
              </div>
            </CardBody>
          </Card>

          {/* Section 4: Customer Advances */}
          <Card>
            <CardHeader
              title="4. Customer Advances (GL 2300)"
              description="Verifies unapplied customer receipts and advances against General Ledger Account 2300."
            />
            <CardBody>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 border-b pb-4 text-sm">
                <div>Subledger Advances: <span className="font-bold tabular">{formatINR(recon.sections.customerAdvances.subledgerBalance)}</span></div>
                <div>GL 2300 Balance: <span className="font-bold tabular">{formatINR(recon.sections.customerAdvances.glBalance)}</span></div>
                <div>Difference: <span className={`font-bold tabular ${parseFloat(recon.sections.customerAdvances.difference) !== 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatINR(recon.sections.customerAdvances.difference)}</span></div>
                <div className="text-right"><StatusBadge label={recon.sections.customerAdvances.status} tone={getStatusTone(recon.sections.customerAdvances.status)} /></div>
              </div>
            </CardBody>
          </Card>

          {/* Section 5: Inventory Valuation */}
          <Card>
            <CardHeader
              title="5. Inventory Valuation (GL 1300)"
              description="Cross-checks perpetual inventory stock ledger valuation against General Ledger Account 1300 (Stock on Hand)."
            />
            <CardBody>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 border-b pb-4 text-sm">
                <div>Stock Ledger Valuation: <span className="font-bold tabular">{formatINR(recon.sections.inventoryValuation.subledgerBalance)}</span></div>
                <div>GL 1300 Balance: <span className="font-bold tabular">{formatINR(recon.sections.inventoryValuation.glBalance)}</span></div>
                <div>Difference: <span className={`font-bold tabular ${parseFloat(recon.sections.inventoryValuation.difference) !== 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatINR(recon.sections.inventoryValuation.difference)}</span></div>
                <div className="text-right"><StatusBadge label={recon.sections.inventoryValuation.status} tone={getStatusTone(recon.sections.inventoryValuation.status)} /></div>
              </div>
            </CardBody>
          </Card>

          {/* Section 6: Tax Accounts */}
          <Card>
            <CardHeader
              title="6. Tax Control Accounts"
              description="Verifies sales tax liability and input tax credit accounts against subledger balances."
            />
            <CardBody>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 border-b pb-4 text-sm">
                <div>Tax Subledger Balance: <span className="font-bold tabular">{formatINR(recon.sections.taxAccounts.subledgerBalance)}</span></div>
                <div>GL Tax Balance: <span className="font-bold tabular">{formatINR(recon.sections.taxAccounts.glBalance)}</span></div>
                <div>Difference: <span className={`font-bold tabular ${parseFloat(recon.sections.taxAccounts.difference) !== 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatINR(recon.sections.taxAccounts.difference)}</span></div>
                <div className="text-right"><StatusBadge label={recon.sections.taxAccounts.status} tone={getStatusTone(recon.sections.taxAccounts.status)} /></div>
              </div>
              {recon.sections.taxAccounts.subAccounts.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b text-muted">
                        <th className="py-1">Account</th>
                        <th className="py-1">Name</th>
                        <th className="py-1 text-right">GL Balance</th>
                        <th className="py-1 text-right">Expected</th>
                        <th className="py-1 text-right">Difference</th>
                        <th className="py-1 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recon.sections.taxAccounts.subAccounts.map((sub) => (
                        <tr key={sub.accountCode} className="border-b last:border-0">
                          <td className="py-1 font-mono">{sub.accountCode}</td>
                          <td className="py-1">{sub.name}</td>
                          <td className="py-1 text-right tabular">{formatINR(sub.glBalance)}</td>
                          <td className="py-1 text-right tabular">{formatINR(sub.expectedBalance)}</td>
                          <td className="py-1 text-right tabular">{formatINR(sub.difference)}</td>
                          <td className="py-1 text-right"><StatusBadge label={sub.status} tone={getStatusTone(sub.status)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
