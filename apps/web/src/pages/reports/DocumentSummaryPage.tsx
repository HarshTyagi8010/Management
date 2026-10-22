import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DocumentIssuedItem, DocumentSummaryResponse } from '@bizmgmt/contracts';
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
  type Column,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, downloadFile } from '../../lib/api';
import { errorMessage, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function DocumentSummaryPage() {
  usePageTitle('Documents Issued (Table 13 Preparation)');
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
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const hasReportPerm = can('report.financial');
  const hasExportPerm = can('export.csv');

  const queryKey = useTenantQueryKey('compliance', 'document-summary', chosenEntity, fromDate, toDate);
  const docQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        legalEntityId: chosenEntity,
        fromDate,
        toDate,
      });
      return api<DocumentSummaryResponse>(`/compliance/document-summary?${params.toString()}`, { signal });
    },
    enabled: Boolean(chosenEntity && hasReportPerm && fromDate && toDate),
  });

  if (!hasReportPerm) {
    return <PermissionDenied permission="report.financial" />;
  }

  const report = docQuery.data;

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
      const filename = `document-summary-${fromDate}-${toDate}.csv`;
      await downloadFile(`/compliance/document-summary/export?${params.toString()}`, filename);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setIsExporting(false);
    }
  };

  const columns: Column<DocumentIssuedItem>[] = [
    {
      key: 'natureOfDocument',
      header: 'Nature of Document',
      render: (r) => <span className="font-semibold text-xs">{r.natureOfDocument}</span>,
    },
    {
      key: 'seriesPrefix',
      header: 'Series Prefix',
      render: (r) => <span className="font-mono text-xs">{r.seriesPrefix || '(none)'}</span>,
    },
    {
      key: 'fromSerial',
      header: 'From Serial No.',
      render: (r) => <span className="font-mono text-xs">{r.fromSerial}</span>,
    },
    {
      key: 'toSerial',
      header: 'To Serial No.',
      render: (r) => <span className="font-mono text-xs">{r.toSerial}</span>,
    },
    {
      key: 'totalIssued',
      header: 'Total Issued',
      align: 'end',
      render: (r) => <span className="tabular font-medium">{r.totalIssued}</span>,
    },
    {
      key: 'cancelled',
      header: 'Cancelled',
      align: 'end',
      render: (r) => (
        <span className={`tabular ${r.cancelled > 0 ? 'font-semibold text-rose-600' : 'text-muted'}`}>
          {r.cancelled}
        </span>
      ),
    },
    {
      key: 'netIssued',
      header: 'Net Issued',
      align: 'end',
      render: (r) => <span className="tabular font-bold">{r.netIssued}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="Documents Issued Summary (GSTR-1 Table 13)"
          description="Statutory document counts and serial number tracking by series for GSTR-1 Table 13."
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
                    disabled={docQuery.isFetching}
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
                    disabled={docQuery.isFetching}
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
                    disabled={docQuery.isFetching}
                  />
                )}
              </FormField>
            </div>

            <Button
              variant="secondary"
              onClick={() => void docQuery.refetch()}
              disabled={docQuery.isFetching}
            >
              {docQuery.isFetching ? 'Loading…' : 'Refresh'}
            </Button>
          </div>

          <div>
            <Button
              variant="primary"
              onClick={handleExport}
              disabled={isExporting || !hasExportPerm || docQuery.isFetching}
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

      {docQuery.isPending && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {docQuery.isError && (
        <Card>
          <CardBody>
            <ErrorState
              message={errorMessage(docQuery.error)}
              onRetry={() => void docQuery.refetch()}
            />
          </CardBody>
        </Card>
      )}

      {report && (
        <div className="space-y-6">
          {/* Table 13 Documents Table */}
          <Card>
            <CardHeader
              title={`Table 13 Statutory Documents (${report.table13Documents.length} series)`}
              description="Outward statutory tax invoices, bills of supply, and credit/debit notes issued under Section 31 and Section 34."
            />
            <CardBody>
              {report.table13Documents.length === 0 ? (
                <EmptyState title="No documents issued" description="No statutory series had issued documents during this period." />
              ) : (
                <DataTable<DocumentIssuedItem>
                  caption="Table 13 Statutory Documents"
                  hideCaption
                  rows={report.table13Documents}
                  columns={columns}
                  rowKey={(r) => `${r.docType}:${r.seriesPrefix}:${r.fromSerial}`}
                />
              )}
            </CardBody>
          </Card>

          {/* Internal Excluded Series */}
          <Card>
            <CardHeader
              title={`Internal Excluded Series (${report.internalExcludedSeries.length})`}
              description="Vouchers strictly excluded from GSTR-1 Table 13 statutory outward document reporting."
            />
            <CardBody>
              <div className="divide-y divide-border text-xs">
                {report.internalExcludedSeries.map((item, i) => (
                  <div key={i} className="py-2.5 flex items-center justify-between">
                    <div>
                      <span className="font-mono font-bold">{item.seriesPrefix}</span> · {item.nature}
                      <p className="text-[11px] text-muted">{item.exclusionReason}</p>
                    </div>
                    <span className="font-semibold">{item.totalCount} documents</span>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          {/* Disclosed Unsupported Categories */}
          <Card>
            <CardHeader
              title="Disclosed Unsupported Table 13 Categories"
              description="Statutory Table 13 categories not supported in current MVP."
            />
            <CardBody>
              <ul className="list-disc pl-5 text-xs text-muted space-y-1">
                {report.unsupportedTable13Categories.map((cat, i) => (
                  <li key={i}>{cat}</li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
