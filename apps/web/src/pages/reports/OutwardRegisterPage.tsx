import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { OutwardExceptionItem, OutwardRegisterResponse, OutwardSupplyCategory, OutwardSupplyLine } from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  KpiCard,
  PermissionDenied,
  Select,
  Skeleton,
  StatusBadge,
  formatBusinessDate,
  formatINR,
  type Column,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, downloadFile } from '../../lib/api';
import { errorMessage, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function OutwardRegisterPage() {
  usePageTitle('Outward Supply Register (GSTR-1 Preparation)');
  const { can } = useSession();
  const entities = useLegalEntities();
  const allowed = entities.data ?? [];

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';

  // Default to current month
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const hasReportPerm = can('report.financial');
  const hasExportPerm = can('export.csv');

  const queryKey = useTenantQueryKey('compliance', 'outward-register', chosenEntity, fromDate, toDate);
  const registerQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        legalEntityId: chosenEntity,
        fromDate,
        toDate,
      });
      return api<OutwardRegisterResponse>(`/compliance/outward-register?${params.toString()}`, { signal });
    },
    enabled: Boolean(chosenEntity && hasReportPerm && fromDate && toDate),
  });

  if (!hasReportPerm) {
    return <PermissionDenied permission="report.financial" />;
  }

  const report = registerQuery.data;

  const handleExport = async () => {
    if (!chosenEntity || !hasExportPerm) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams({
        legalEntityId: chosenEntity,
        fromDate,
        toDate,
      });
      const filename = `outward-register-${fromDate}-${toDate}.csv`;
      await downloadFile(`/compliance/outward-register/export?${params.toString()}`, filename);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setIsExporting(false);
    }
  };

  const filteredLines = report?.lines.filter((l) => {
    if (selectedCategory === 'ALL') return true;
    return l.category === selectedCategory;
  }) ?? [];

  const lineColumns: Column<OutwardSupplyLine>[] = [
    {
      key: 'documentNumber',
      header: 'Doc #',
      render: (r) => <span className="font-mono text-xs font-semibold">{r.documentNumber}</span>,
    },
    {
      key: 'docDate',
      header: 'Date',
      render: (r) => formatBusinessDate(r.docDate),
    },
    {
      key: 'partyName',
      header: 'Customer',
      render: (r) => (
        <div>
          <div className="font-medium text-xs">{r.partyName}</div>
          {r.recipientGstin ? (
            <div className="font-mono text-[10px] text-muted">{r.recipientGstin}</div>
          ) : (
            <div className="text-[10px] text-muted italic">Unregistered</div>
          )}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'GSTR Table',
      render: (r) => {
        let label = r.category;
        if (r.category === 'B2CL') label = 'Table 5 (B2CL)' as any;
        if (r.category === 'B2CS') label = 'Table 7 (B2CS)' as any;
        if (r.category === 'B2B') label = 'Table 4A (B2B)' as any;
        return <span className="font-mono text-xs font-medium">{label}</span>;
      },
    },
    {
      key: 'placeOfSupply',
      header: 'PoS',
      render: (r) => <span className="text-xs">{r.placeOfSupply} ({r.supplyType})</span>,
    },
    {
      key: 'taxableValue',
      header: 'Taxable (₹)',
      align: 'end',
      render: (r) => <span className="tabular font-medium">{formatINR(r.taxableValue)}</span>,
    },
    {
      key: 'totalTax',
      header: 'Tax (₹)',
      align: 'end',
      render: (r) => <span className="tabular">{formatINR(r.totalTax)}</span>,
    },
    {
      key: 'grandTotal',
      header: 'Total (₹)',
      align: 'end',
      render: (r) => <span className="tabular font-bold">{formatINR(r.grandTotal)}</span>,
    },
  ];

  const exceptionColumns: Column<OutwardExceptionItem>[] = [
    {
      key: 'documentNumber',
      header: 'Doc #',
      render: (r) => <span className="font-mono text-xs font-bold text-rose-700">{r.documentNumber}</span>,
    },
    {
      key: 'docDate',
      header: 'Date',
      render: (r) => formatBusinessDate(r.docDate),
    },
    {
      key: 'partyName',
      header: 'Party',
      render: (r) => <span className="text-xs">{r.partyName}</span>,
    },
    {
      key: 'reasonCode',
      header: 'Exception Reason',
      render: (r) => (
        <div>
          <StatusBadge label={r.reasonCode} tone="danger" />
          <p className="mt-1 text-[11px] text-muted">{r.message}</p>
        </div>
      ),
    },
    {
      key: 'grandTotal',
      header: 'Total (₹)',
      align: 'end',
      render: (r) => <span className="tabular font-semibold text-rose-700">{formatINR(r.grandTotal)}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="Outward Supply Preparation Register"
          description="Statutory preparation for GSTR-1 outward taxable and exempt supplies, credit notes, and exception segregation."
        />
        <StatusBadge label="PREPARATION ONLY — NOT FILED" tone="warning" />
      </div>

      {/* Filter and Export Toolbar */}
      <Card>
        <CardBody className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-56">
              <FormField label="Business Entity">
                {(f) => (
                  <Select
                    {...f}
                    value={chosenEntity}
                    onChange={(e) => setSelectedEntityId(e.target.value)}
                    disabled={registerQuery.isFetching}
                  >
                    {allowed.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.legalName}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            </div>

            <div className="w-40">
              <FormField label="From Date">
                {(f) => (
                  <Input
                    {...f}
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    disabled={registerQuery.isFetching}
                  />
                )}
              </FormField>
            </div>

            <div className="w-40">
              <FormField label="To Date">
                {(f) => (
                  <Input
                    {...f}
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    disabled={registerQuery.isFetching}
                  />
                )}
              </FormField>
            </div>

            <Button
              variant="secondary"
              onClick={() => void registerQuery.refetch()}
              disabled={registerQuery.isFetching}
            >
              {registerQuery.isFetching ? 'Loading…' : 'Refresh'}
            </Button>
          </div>

          <div>
            <Button
              variant="primary"
              onClick={handleExport}
              disabled={isExporting || !hasExportPerm || registerQuery.isFetching}
            >
              {isExporting ? 'Exporting CSV…' : 'Export RFC 4180 CSV'}
            </Button>
          </div>
        </CardBody>
      </Card>

      {exportError && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800">
          Export failed: {exportError}
        </div>
      )}

      {registerQuery.isPending && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {registerQuery.isError && (
        <Card>
          <CardBody>
            <ErrorState
              message={errorMessage(registerQuery.error)}
              onRetry={() => void registerQuery.refetch()}
            />
          </CardBody>
        </Card>
      )}

      {report && (
        <div className="space-y-6">
          {/* Population Reconciliation Banner */}
          <Card className={report.reconciliation.isPopulationReconciled ? 'border-emerald-300 bg-emerald-50/20' : 'border-rose-300 bg-rose-50/20'}>
            <CardHeader
              title="Population Reconciliation Status"
              description="Verifies that all source invoices and credit notes are fully classified without silent exclusions."
            />
            <CardBody>
              <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
                <div className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4 text-sm">
                  <div>Source Documents: <span className="font-bold">{report.reconciliation.totalSourceDocumentsCount}</span></div>
                  <div>Source Grand Total: <span className="font-bold tabular">{formatINR(report.reconciliation.totalSourceGrandTotal)}</span></div>
                  <div>Classified Grand Total: <span className="font-bold tabular">{formatINR(report.summaries.reduce((acc, s) => acc + parseFloat(s.grandTotal), 0).toFixed(2))}</span></div>
                  <div>Exceptions Value: <span className="font-bold tabular text-rose-700">{formatINR(report.reconciliation.exceptionsTaxableValue)}</span></div>
                </div>
                <StatusBadge
                  label={report.reconciliation.isPopulationReconciled ? 'POPULATION RECONCILED (100%)' : 'POPULATION DISCREPANCY'}
                  tone={report.reconciliation.isPopulationReconciled ? 'success' : 'danger'}
                />
              </div>

              {!report.reconciliation.isPopulationReconciled && (
                <div className="mt-3 text-xs font-semibold text-rose-700">
                  Difference detected: Taxable diff ₹{report.reconciliation.differenceTaxableValue}, Tax diff ₹{report.reconciliation.differenceTaxAmount}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Statutory Category Summary KPI Cards */}
          <div>
            <h3 className="mb-3 text-sm font-semibold">Statutory Table Breakdown</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {report.summaries.map((s) => (
                <div key={s.category} className="rounded-lg border border-border bg-surface p-4 shadow-card">
                  <div className="text-xs font-medium text-muted">
                    {s.category === 'B2CL'
                      ? 'Table 5: B2CL Large Inter-state'
                      : s.category === 'B2CS'
                      ? 'Table 7: B2CS Small Unregistered'
                      : s.category === 'B2B'
                      ? 'Table 4A: B2B Regular'
                      : s.category === 'CDNR'
                      ? 'Table 9B: CDNR Registered'
                      : s.category === 'CDNUR'
                      ? 'Table 9B: CDNUR Unregistered (B2CL only)'
                      : `Table 8: ${s.category}`}
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular text-text">{formatINR(s.grandTotal)}</div>
                  <div className="mt-1 text-xs text-muted">
                    {s.documentCount} docs · Taxable: {formatINR(s.taxableValue)} · Tax: {formatINR(s.totalTax)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Exceptions Section (if any exist) */}
          {report.exceptions.length > 0 && (
            <Card className="border-rose-300">
              <CardHeader
                title={`Compliance Exceptions (${report.exceptions.length})`}
                description="Documents failing statutory validation (missing place of supply, unclassified zero rates). Kept outside confirmed categories until resolved."
              />
              <CardBody>
                <DataTable<OutwardExceptionItem>
                  caption="Compliance Exceptions"
                  hideCaption
                  rows={report.exceptions}
                  columns={exceptionColumns}
                  rowKey={(r) => `${r.documentId}:${r.reasonCode}`}
                />
              </CardBody>
            </Card>
          )}

          {/* Classified Source Lines Table */}
          <Card>
            <CardHeader
              title="Classified Outward Supplies"
              description="Detailed line items mapped to statutory reporting tables."
            />
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-muted">Filter Table:</span>
                {['ALL', 'B2B', 'B2CL', 'B2CS', 'NIL_RATED', 'EXEMPTED', 'NON_GST', 'CDNR', 'CDNUR'].map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                      selectedCategory === cat
                        ? 'bg-accent text-accent-contrast'
                        : 'bg-muted/10 text-muted hover:bg-muted/20'
                    }`}
                  >
                    {cat === 'B2CL' ? 'Table 5 (B2CL)' : cat === 'B2CS' ? 'Table 7 (B2CS)' : cat}
                  </button>
                ))}
              </div>

              {filteredLines.length === 0 ? (
                <EmptyState
                  title="No outward supplies found"
                  description="No transactions matched the selected date range and statutory category."
                />
              ) : (
                <DataTable<OutwardSupplyLine>
                  caption="Classified Outward Supplies"
                  hideCaption
                  rows={filteredLines}
                  columns={lineColumns}
                  rowKey={(r) => r.documentId}
                />
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
