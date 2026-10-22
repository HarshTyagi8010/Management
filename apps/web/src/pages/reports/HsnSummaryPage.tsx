import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { HsnSummaryItem, HsnSummaryResponse } from '@bizmgmt/contracts';
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
  formatINR,
  type Column,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, downloadFile } from '../../lib/api';
import { errorMessage, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function HsnSummaryPage() {
  usePageTitle('HSN/SAC Summary (Table 12 Preparation)');
  const { can } = useSession();
  const entities = useLegalEntities();
  const allowed = entities.data ?? [];

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';

  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [tab, setTab] = useState<'b2b' | 'b2c'>('b2b');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const hasReportPerm = can('report.financial');
  const hasExportPerm = can('export.csv');

  const queryKey = useTenantQueryKey('compliance', 'hsn-summary', chosenEntity, fromDate, toDate);
  const hsnQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        legalEntityId: chosenEntity,
        fromDate,
        toDate,
      });
      return api<HsnSummaryResponse>(`/compliance/hsn-summary?${params.toString()}`, { signal });
    },
    enabled: Boolean(chosenEntity && hasReportPerm && fromDate && toDate),
  });

  if (!hasReportPerm) {
    return <PermissionDenied permission="report.financial" />;
  }

  const report = hsnQuery.data;

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
      const filename = `hsn-summary-${fromDate}-${toDate}.csv`;
      await downloadFile(`/compliance/hsn-summary/export?${params.toString()}`, filename);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setIsExporting(false);
    }
  };

  const columns: Column<HsnSummaryItem>[] = [
    {
      key: 'hsnSac',
      header: 'HSN / SAC',
      render: (r) => <span className="font-mono text-xs font-bold">{r.hsnSac}</span>,
    },
    {
      key: 'description',
      header: 'Description',
      render: (r) => (
        <div>
          <div className="font-medium text-xs">{r.description}</div>
          <div className="text-[10px] text-muted capitalize">{r.itemType.replace('_', ' ')}</div>
        </div>
      ),
    },
    {
      key: 'uqc',
      header: 'UQC',
      render: (r) => <span className="font-mono text-xs">{r.uqc}</span>,
    },
    {
      key: 'totalQty',
      header: 'Total Qty',
      align: 'end',
      render: (r) => <span className="tabular text-xs">{r.totalQty || '—'}</span>,
    },
    {
      key: 'rate',
      header: 'Rate (%)',
      align: 'end',
      render: (r) => <span className="tabular text-xs font-medium">{r.rate ? `${r.rate}%` : '0%'}</span>,
    },
    {
      key: 'taxableValue',
      header: 'Taxable (₹)',
      align: 'end',
      render: (r) => <span className="tabular font-medium">{formatINR(r.taxableValue)}</span>,
    },
    {
      key: 'totalTax',
      header: 'Total Tax (₹)',
      align: 'end',
      render: (r) => <span className="tabular">{formatINR(r.totalTax)}</span>,
    },
    {
      key: 'totalValue',
      header: 'Total Value (₹)',
      align: 'end',
      render: (r) => <span className="tabular font-bold">{formatINR(r.totalValue)}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="HSN/SAC Summary (GSTR-1 Table 12)"
          description="Commodity and service summaries formatted for GSTR-1 Table 12 filing preparation."
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
                    disabled={hsnQuery.isFetching}
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
                    disabled={hsnQuery.isFetching}
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
                    disabled={hsnQuery.isFetching}
                  />
                )}
              </FormField>
            </div>

            <Button
              variant="secondary"
              onClick={() => void hsnQuery.refetch()}
              disabled={hsnQuery.isFetching}
            >
              {hsnQuery.isFetching ? 'Loading…' : 'Refresh'}
            </Button>
          </div>

          <div>
            <Button
              variant="primary"
              onClick={handleExport}
              disabled={isExporting || !hasExportPerm || hsnQuery.isFetching}
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

      {hsnQuery.isPending && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {hsnQuery.isError && (
        <Card>
          <CardBody>
            <ErrorState
              message={errorMessage(hsnQuery.error)}
              onRetry={() => void hsnQuery.refetch()}
            />
          </CardBody>
        </Card>
      )}

      {report && (
        <div className="space-y-6">
          {/* Summary KPIs */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Total Taxable Value</div>
              <div className="mt-1 text-lg font-semibold tabular text-text">{formatINR(report.totals.totalTaxable)}</div>
              <div className="mt-1 text-xs text-muted">Sum across all HSN/SAC lines</div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Total Tax Amount</div>
              <div className="mt-1 text-lg font-semibold tabular text-text">{formatINR(report.totals.totalTax)}</div>
              <div className="mt-1 text-xs text-muted">CGST + SGST + IGST + Cess</div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Total Invoiced Value</div>
              <div className="mt-1 text-lg font-semibold tabular text-text">{formatINR(report.totals.totalValue)}</div>
              <div className="mt-1 text-xs text-muted">Gross supplies value</div>
            </div>
          </div>

          {/* Exceptions Table (if any) */}
          {report.exceptions.length > 0 && (
            <Card className="border-rose-300">
              <CardHeader
                title={`HSN/SAC Validation Exceptions (${report.exceptions.length})`}
                description="Lines with missing or invalid HSN digits based on entity turnover band."
              />
              <CardBody>
                <div className="divide-y divide-border text-xs">
                  {report.exceptions.map((ex, i) => (
                    <div key={i} className="py-2 flex items-center justify-between">
                      <div>
                        <span className="font-mono font-semibold">{ex.documentNumber}</span> · Line: {ex.itemName}
                      </div>
                      <span className="text-rose-700 font-medium">{ex.reason}</span>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}

          {/* Tabbed Table */}
          <Card>
            <CardHeader
              title="Table 12 HSN/SAC Breakdown"
              description="Separated into B2B and B2C summaries as required by GST statutory reporting."
            />
            <CardBody className="space-y-4">
              <div className="flex gap-2 border-b pb-2">
                <button
                  type="button"
                  onClick={() => setTab('b2b')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-t ${
                    tab === 'b2b'
                      ? 'border-b-2 border-accent text-accent'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  B2B Summaries ({report.b2bSummary.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTab('b2c')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-t ${
                    tab === 'b2c'
                      ? 'border-b-2 border-accent text-accent'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  B2C Summaries ({report.b2cSummary.length})
                </button>
              </div>

              {tab === 'b2b' ? (
                report.b2bSummary.length === 0 ? (
                  <EmptyState title="No B2B HSN entries" description="No B2B invoice lines found in this period." />
                ) : (
                  <DataTable<HsnSummaryItem>
                    caption="B2B HSN Summaries"
                    hideCaption
                    rows={report.b2bSummary}
                    columns={columns}
                    rowKey={(r) => `${r.hsnSac}:${r.recipientCategory}:${r.rate ?? '0'}`}
                  />
                )
              ) : report.b2cSummary.length === 0 ? (
                <EmptyState title="No B2C HSN entries" description="No B2C invoice lines found in this period." />
              ) : (
                <DataTable<HsnSummaryItem>
                  caption="B2C HSN Summaries"
                  hideCaption
                  rows={report.b2cSummary}
                  columns={columns}
                  rowKey={(r) => `${r.hsnSac}:${r.recipientCategory}:${r.rate ?? '0'}`}
                />
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
