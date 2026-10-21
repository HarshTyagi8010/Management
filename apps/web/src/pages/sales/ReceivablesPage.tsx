import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AGEING_BUCKET_LABELS, AGEING_BUCKETS, receivablesSchema, type Receivables } from '@bizmgmt/contracts';
import { Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, FormField, Input, PermissionDenied, Select, Skeleton, StatusBadge, formatBusinessDate, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { DocLink, docRoute, rupees, todayIST } from './shared';

type Row = Receivables['invoices'][number];

/** Receivables (FR-SAL-09): what customers owe on issued invoices, by due date. Payables arrive with purchasing (Phase 8). */
export function ReceivablesPage() {
  usePageTitle('Outstanding & ageing');
  const { can, canIn, tenantContext } = useSession();
  const entities = useLegalEntities();
  const allowed = (entities.data ?? []).filter((e) => canIn('report.sales', e.id) || canIn('report.financial', e.id));
  const [entityId, setEntityId] = useState('');
  const [asOf, setAsOf] = useState(todayIST());
  const chosen = entityId || allowed[0]?.id || '';
  const key = useTenantQueryKey('receivables', chosen, asOf);
  const data = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/receivables?legalEntityId=${chosen}&asOf=${asOf}`, { schema: receivablesSchema, signal }),
    enabled: chosen !== '' && /^\d{4}-\d{2}-\d{2}$/.test(asOf),
  });
  const header = <PageHeader title="Outstanding & ageing" description="Receivables from issued invoices by how long they are past their due date. Receipts and payables arrive in later phases; until then an invoice’s outstanding is its total." />;
  if (!tenantContext || entities.isPending) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('report.sales') && !can('report.financial')) return <>{header}<Card className="mt-6"><PermissionDenied permission="report.sales" /></Card></>;

  const invoiceColumns: Column<Row>[] = [
    { key: 'number', header: 'Invoice', primary: true, render: (r) => <DocLink to={docRoute('sales_invoice', r.invoiceId)}>{r.number}</DocLink> },
    { key: 'party', header: 'Customer', render: (r) => r.partyName },
    { key: 'due', header: 'Due', render: (r) => <span className="tabular whitespace-nowrap">{formatBusinessDate(r.dueDate)}</span> },
    { key: 'age', header: 'Age', render: (r) => (r.bucket === 'not_due' ? <StatusBadge tone="neutral" label="Not yet due" /> : <StatusBadge tone={r.daysOverdue > 60 ? 'danger' : 'warning'} label={`${r.daysOverdue} days overdue`} />) },
    { key: 'outstanding', header: 'Outstanding', align: 'end', render: (r) => rupees(r.outstanding) },
  ];
  type PartyRow = Receivables['parties'][number];
  const partyColumns: Column<PartyRow>[] = [
    { key: 'party', header: 'Customer', primary: true, render: (p) => <span className="font-medium">{p.partyName}</span> },
    { key: 'invoices', header: 'Invoices', align: 'end', render: (p) => p.invoices },
    { key: 'overdue', header: 'Overdue', align: 'end', render: (p) => rupees(p.overdue) },
    { key: 'outstanding', header: 'Outstanding', align: 'end', render: (p) => rupees(p.outstanding) },
  ];

  return (
    <>
      {header}
      <Card className="mt-6">
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allowed.length > 1 && (
            <FormField label="Business entity">
              {(f) => (
                <Select {...f} value={chosen} onChange={(e) => setEntityId(e.target.value)}>
                  {allowed.map((e) => (
                    <option key={e.id} value={e.id}>{e.legalName}</option>
                  ))}
                </Select>
              )}
            </FormField>
          )}
          <FormField label="As of">
            {(f) => <Input {...f} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}
          </FormField>
        </CardBody>
      </Card>
      {!chosen ? (
        <Card className="mt-6">
          <EmptyState title="No business entity" description="Add a business entity under Settings › Company & GST." />
        </Card>
      ) : data.isPending ? (
        <Skeleton className="mt-6 h-64" />
      ) : data.isError ? (
        <Card className="mt-6">
          <ErrorState message={errorMessage(data.error)} onRetry={() => void data.refetch()} />
        </Card>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Card>
              <CardHeader title="Summary" description={`As of ${formatBusinessDate(data.data.asOf)}`} />
              <CardBody>
                <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
                  <dt className="font-semibold">Outstanding</dt>
                  <dd className="tabular text-right font-semibold">{rupees(data.data.total)}</dd>
                  <dt className="text-muted">Of which overdue</dt>
                  <dd className="tabular text-right">{rupees(data.data.overdue)}</dd>
                  {AGEING_BUCKETS.map((b) => (
                    <div key={b} className="contents">
                      <dt className="text-muted">{AGEING_BUCKET_LABELS[b]}</dt>
                      <dd className="tabular text-right">{rupees(data.data.buckets[b])}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="By customer" />
              <div className="py-4">
                <DataTable caption="Outstanding by customer" hideCaption columns={partyColumns} rows={data.data.parties} rowKey={(p) => p.partyId} empty={<EmptyState title="Nothing outstanding" description="Issued invoices that are not yet paid appear here." />} />
              </div>
            </Card>
          </div>
          <Card className="mt-6">
            <CardHeader title="Invoices" description={data.data.truncated ? 'Showing the first 500 by due date.' : 'Oldest due first.'} />
            <div className="py-4">
              <DataTable caption="Outstanding invoices" hideCaption columns={invoiceColumns} rows={data.data.invoices} rowKey={(r) => r.invoiceId} empty={<EmptyState title="No outstanding invoices" description="Nothing is owed on this date." />} />
            </div>
          </Card>
        </>
      )}
    </>
  );
}
