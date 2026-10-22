import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { PurchaseRegisterLine, PurchaseRegisterResponse } from '@bizmgmt/contracts';
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

export function PurchaseRegisterPage() {
  usePageTitle('Purchase Register & ITC Review');
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
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const hasReportPerm = can('report.financial');
  const hasExportPerm = can('export.csv');

  const queryKey = useTenantQueryKey('compliance', 'purchase-register', chosenEntity, fromDate, toDate);
  const registerQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        legalEntityId: chosenEntity,
        fromDate,
        toDate,
      });
      return api<PurchaseRegisterResponse>(`/compliance/purchase-register?${params.toString()}`, { signal });
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
      const filename = `purchase-register-${fromDate}-${toDate}.csv`;
      await downloadFile(`/compliance/purchase-register/export?${params.toString()}`, filename);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setIsExporting(false);
    }
  };

  const filteredLines = report?.lines.filter((l) => {
    if (filterCategory === 'ALL') return true;
    return l.gstr3bCategory === filterCategory;
  }) ?? [];

  const columns: Column<PurchaseRegisterLine>[] = [
    {
      key: 'docNumber',
      header: 'Doc #',
      render: (r) => <span className="font-mono text-xs font-semibold">{r.docNumber}</span>,
    },
    {
      key: 'docDate',
      header: 'Date',
      render: (r) => formatBusinessDate(r.docDate),
    },
    {
      key: 'supplierName',
      header: 'Supplier',
      render: (r) => (
        <div>
          <div className="font-medium text-xs">{r.supplierName}</div>
          {r.supplierGstin && <div className="font-mono text-[10px] text-muted">{r.supplierGstin}</div>}
        </div>
      ),
    },
    {
      key: 'docType',
      header: 'Type',
      render: (r) => <span className="capitalize text-xs">{r.docType.replace(/_/g, ' ')}</span>,
    },
    {
      key: 'gstr3bCategory',
      header: 'GSTR-3B Classification',
      render: (r) => {
        if (r.gstr3bCategory === 'REVIEW_REQUIRED') {
          return (
            <div>
              <StatusBadge label="REVIEW REQUIRED" tone="warning" />
              {r.reviewReason && <p className="mt-1 max-w-xs text-[10px] text-amber-800 dark:text-amber-300">{r.reviewReason}</p>}
            </div>
          );
        }
        if (r.gstr3bCategory === 'TABLE_4_A_5_ALL_OTHER_ITC') {
          return <StatusBadge label="Table 4(A)(5) Eligible" tone="success" />;
        }
        if (r.gstr3bCategory === 'INELIGIBLE_GROSS_EXPENSED') {
          return <StatusBadge label="Expensed (Gross Cost)" tone="neutral" />;
        }
        return <StatusBadge label={r.gstr3bCategory} tone="neutral" />;
      },
    },
    {
      key: 'taxable',
      header: 'Taxable (₹)',
      align: 'end',
      render: (r) => <span className="tabular font-medium">{formatINR(r.taxCharged.taxable)}</span>,
    },
    {
      key: 'totalTax',
      header: 'Tax (₹)',
      align: 'end',
      render: (r) => (
        <span className={`tabular font-bold ${r.gstr3bCategory === 'REVIEW_REQUIRED' ? 'text-amber-700 dark:text-amber-400' : ''}`}>
          {formatINR(r.taxCharged.totalTax)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="Purchase Register & ITC Review Preparation"
          description="Internal statutory preparation for Inward Supplies and Input Tax Credit (ITC) eligibility review."
        />
        <StatusBadge label="PREPARATION ONLY — NOT FILED" tone="warning" />
      </div>

      {/* Prominent Statutory Warning */}
      <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-bold">Notice: Internal Inward Preparation Only</p>
        <p className="mt-1 text-xs">
          This register records internal inward bills and expenses with declared eligibility. It is <strong>NOT a GSTR-2B external statement reconciliation</strong>.
          Commercial return memos and inward reverse charge (RCM) supplies are kept in <strong>REVIEW_REQUIRED</strong> and excluded from confirmed claim-ready totals
          until external credit notes or tax payment evidence are verified.
        </p>
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
          {/* Statutory Totals Breakdown */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Total Inward Tax Charged</div>
              <div className="mt-1 text-lg font-semibold tabular text-text">{formatINR(report.totals.totalInwardTaxCharged)}</div>
              <div className="mt-1 text-xs text-muted">Taxable: {formatINR(report.totals.totalInwardTaxable)}</div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Confirmed Claim-Ready ITC (4A5)</div>
              <div className="mt-1 text-lg font-semibold tabular text-text">{formatINR(report.totals.eligibleTaxCharged)}</div>
              <div className="mt-1 text-xs text-muted">Eligible inward supplies</div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Under Review Tax (RCM / Memos)</div>
              <div className="mt-1 text-lg font-semibold tabular text-text">
                {formatINR(
                  (parseFloat(report.totals.totalInwardTaxCharged) - parseFloat(report.totals.eligibleTaxCharged) - parseFloat(report.totals.ineligibleGrossExpensedTax)).toFixed(2)
                )}
              </div>
              <div className="mt-1 text-xs text-muted">{report.totals.reviewRequiredCount} lines requiring review</div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="text-xs font-medium text-muted">Ineligible Expensed Tax</div>
              <div className="mt-1 text-lg font-semibold tabular text-text">{formatINR(report.totals.ineligibleGrossExpensedTax)}</div>
              <div className="mt-1 text-xs text-muted">Gross cost debited to 5100/1300</div>
            </div>
          </div>

          {/* Inward Supplies Table */}
          <Card>
            <CardHeader
              title={`Inward Supplies & Vouchers (${report.lines.length})`}
              description="Line items classified by statutory ITC treatment."
            />
            <CardBody className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-muted">Category Filter:</span>
                {[
                  { id: 'ALL', label: 'All Inward Supplies' },
                  { id: 'TABLE_4_A_5_ALL_OTHER_ITC', label: 'Eligible ITC (Table 4A5)' },
                  { id: 'REVIEW_REQUIRED', label: `Review Required (${report.totals.reviewRequiredCount})` },
                  { id: 'INELIGIBLE_GROSS_EXPENSED', label: 'Ineligible Expensed' },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setFilterCategory(cat.id)}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                      filterCategory === cat.id
                        ? 'bg-accent text-accent-contrast'
                        : 'bg-muted/10 text-muted hover:bg-muted/20'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {filteredLines.length === 0 ? (
                <EmptyState
                  title="No purchase lines match filter"
                  description="No lines found under the selected category."
                />
              ) : (
                <DataTable<PurchaseRegisterLine>
                  caption="Inward Supplies"
                  hideCaption
                  rows={filteredLines}
                  columns={columns}
                  rowKey={(r) => r.docId}
                />
              )}
            </CardBody>
          </Card>

          {/* Disclosed Unsupported Features */}
          <Card>
            <CardHeader
              title="Disclosed Inward Capabilities & Boundaries"
              description="Clarification of features not currently automated in internal inward preparation."
            />
            <CardBody>
              <ul className="list-disc pl-5 text-xs text-muted space-y-1">
                {report.unsupportedFeatures.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
