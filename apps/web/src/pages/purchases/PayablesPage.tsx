import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  payablesSchema,
  type PayablesSummary,
  type PayableItem,
} from '@bizmgmt/contracts';
import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  PermissionDenied,
  Select,
  Skeleton,
  StatusBadge,
  formatBusinessDate,
  type Column,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { DocLink, rupees, todayIST } from './shared';

export function PayablesPage() {
  usePageTitle('Supplier payables & ageing');
  const { can, canIn, tenantContext } = useSession();
  const entities = useLegalEntities();
  const allowed = (entities.data ?? []).filter((e) => canIn('report.financial', e.id) || canIn('purchase.edit', e.id));
  const [entityId, setEntityId] = useState('');
  const [asOf, setAsOf] = useState(todayIST());
  const chosen = entityId || allowed[0]?.id || '';
  const key = useTenantQueryKey('payables', chosen, asOf);

  const data = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/purchases/payables?legalEntityId=${chosen}&asOf=${asOf}`, { schema: payablesSchema, signal }),
    enabled: chosen !== '' && /^\d{4}-\d{2}-\d{2}$/.test(asOf),
  });

  const header = (
    <PageHeader
      title="Supplier payables & ageing"
      description="Outstanding trade payable obligations to suppliers from posted bills, bucketed by due date."
    />
  );

  if (!tenantContext || entities.isPending) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('report.financial') && !can('purchase.edit')) {
    return <>{header}<Card className="mt-6"><PermissionDenied permission="report.financial" /></Card></>;
  }

  const billColumns: Column<PayableItem>[] = [
    { key: 'number', header: 'Bill', primary: true, render: (r) => <DocLink to={`/purchases/bills/${r.id}`}>{r.billNumber}</DocLink> },
    { key: 'party', header: 'Supplier', render: (r) => r.supplierName },
    {
      key: 'invRef',
      header: 'Supplier invoice',
      render: (r) => <span className="font-mono text-xs">{r.supplierInvoiceNumber}</span>,
    },
    { key: 'due', header: 'Due', render: (r) => <span className="tabular whitespace-nowrap">{formatBusinessDate(r.dueDate)}</span> },
    {
      key: 'age',
      header: 'Age',
      render: (r) => (
        r.ageingBucket === 'not_due'
          ? <StatusBadge tone="neutral" label="Not yet due" />
          : <StatusBadge tone={r.daysOverdue > 60 ? 'danger' : 'warning'} label={`${r.daysOverdue} days overdue`} />
      ),
    },
    { key: 'outstanding', header: 'Outstanding', align: 'end', render: (r) => <span className="tabular font-semibold">{rupees(r.outstanding)}</span> },
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
          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-3">
              <CardHeader title="Summary & Ageing Buckets" description={`As of ${formatBusinessDate(asOf)}`} />
              <CardBody>
                <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-sm">
                  <div className="p-3 bg-card border border-border rounded-md">
                    <dt className="text-muted">Total Payables</dt>
                    <dd className="tabular text-lg font-bold">{rupees(data.data.totalOutstanding)}</dd>
                  </div>
                  <div className="p-3 bg-card border border-border rounded-md">
                    <dt className="text-muted">Not yet due</dt>
                    <dd className="tabular text-lg font-semibold">{rupees(data.data.notDue)}</dd>
                  </div>
                  <div className="p-3 bg-card border border-border rounded-md">
                    <dt className="text-muted">1–30 days</dt>
                    <dd className="tabular text-lg font-semibold text-warning">{rupees(data.data.bucket1_30)}</dd>
                  </div>
                  <div className="p-3 bg-card border border-border rounded-md">
                    <dt className="text-muted">31–60 days</dt>
                    <dd className="tabular text-lg font-semibold text-warning">{rupees(data.data.bucket31_60)}</dd>
                  </div>
                  <div className="p-3 bg-card border border-border rounded-md">
                    <dt className="text-muted">61–90 days</dt>
                    <dd className="tabular text-lg font-semibold text-danger">{rupees(data.data.bucket61_90)}</dd>
                  </div>
                  <div className="p-3 bg-card border border-border rounded-md">
                    <dt className="text-muted">&gt; 90 days</dt>
                    <dd className="tabular text-lg font-bold text-danger">{rupees(data.data.bucketOver90)}</dd>
                  </div>
                </dl>
              </CardBody>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader title="Unpaid supplier bills" />
            <DataTable caption="Unpaid supplier bills" hideCaption columns={billColumns} rows={data.data.bills} rowKey={(r) => r.id} />
          </Card>
        </>
      )}
    </>
  );
}
