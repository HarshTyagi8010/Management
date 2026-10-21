import { Boxes, FlaskConical, HandCoins, Landmark, ShoppingCart, TrendingUp } from 'lucide-react';
import { lazy, Suspense, useId } from 'react';
import { Card, CardHeader, DataTable, KpiCard, Skeleton, StatusBadge, formatBusinessDate, formatINR } from '@bizmgmt/ui';
import { ActivityFeed } from '../features/dashboard/ActivityFeed';
import { FollowUpCalendar } from '../features/dashboard/FollowUpCalendar';
import { QuickActions } from '../features/dashboard/QuickActions';
import {
  SAMPLE_ACTIVITY,
  SAMPLE_AS_OF,
  SAMPLE_EVENTS,
  SAMPLE_KPIS,
  SAMPLE_MONTHLY,
  SAMPLE_OVERDUE,
  type Kpi,
  type OverdueInvoice,
} from '../features/dashboard/sample-data';
import { usePageTitle } from './usePageTitle';

// The chart library is large; load it after the rest of the dashboard (NFR-PERF-02).
const SalesPurchaseChart = lazy(() =>
  import('../features/dashboard/SalesPurchaseChart').then((m) => ({ default: m.SalesPurchaseChart })),
);

function ChartSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading chart" className="p-5">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="mt-2 h-4 w-64" />
      <Skeleton className="mt-6 h-64 w-full" />
    </Card>
  );
}

const KPI_ICON: Record<Kpi['key'], React.ReactNode> = {
  sales: <TrendingUp size={16} />,
  purchases: <ShoppingCart size={16} />,
  receivables: <HandCoins size={16} />,
  payables: <Landmark size={16} />,
  inventory: <Boxes size={16} />,
};

function ageTone(days: number) {
  return days > 45 ? 'danger' : days > 15 ? 'warning' : 'info';
}

function OverdueReceivables({ rows }: { rows: OverdueInvoice[] }) {
  const headingId = useId();
  return (
    <Card aria-labelledby={headingId} className="min-w-0">
      <CardHeader id={headingId} title="Overdue receivables" description="Invoices past their due date" />
      <div className="mt-4">
        <DataTable
          caption="Overdue invoices"
          hideCaption
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            { key: 'number', header: 'Invoice', primary: true, render: (r) => <span className="font-medium">{r.number}</span> },
            { key: 'party', header: 'Customer', render: (r) => r.party },
            { key: 'due', header: 'Due date', render: (r) => <span className="tabular">{formatBusinessDate(r.dueDate)}</span> },
            { key: 'age', header: 'Overdue', render: (r) => <StatusBadge tone={ageTone(r.daysOverdue)} label={`${r.daysOverdue} days`} /> },
            { key: 'amount', header: 'Outstanding', align: 'end', render: (r) => formatINR(r.outstanding) },
          ]}
        />
      </div>
    </Card>
  );
}

export function DashboardPage() {
  usePageTitle('Dashboard');
  const asOf = `As of ${formatBusinessDate(SAMPLE_AS_OF)}`;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-0.5 text-muted">Overview of sales, purchases, money and stock</p>
        </div>
      </div>

      <div role="note" className="mt-4 flex items-start gap-3 rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-[0.8125rem]">
        <FlaskConical aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-warning" />
        <p>
          <strong className="font-semibold">Sample data.</strong> These figures are fictional and exist only to preview the layout.
          The dashboard connects to your real books when reporting is built (Phase 11).
        </p>
      </div>

      <ul aria-label="Key figures" className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6 min-[1400px]:grid-cols-5">
        {SAMPLE_KPIS.map((kpi, i) => (
          <li key={kpi.key} className={`min-w-0 [&>section]:h-full min-[1400px]:col-span-1 ${i < 3 ? 'lg:col-span-2' : 'lg:col-span-3'} ${i === 4 ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
            <KpiCard label={kpi.label} value={kpi.value} definition={kpi.definition} asOf={asOf} icon={KPI_ICON[kpi.key]} />
          </li>
        ))}
      </ul>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-8">
          <Suspense fallback={<ChartSkeleton />}>
            <SalesPurchaseChart data={SAMPLE_MONTHLY} />
          </Suspense>
        </div>
        <div className="min-w-0 xl:col-span-4">
          <FollowUpCalendar events={SAMPLE_EVENTS} today={SAMPLE_AS_OF} />
        </div>
        <div className="min-w-0 xl:col-span-8">
          <OverdueReceivables rows={SAMPLE_OVERDUE} />
        </div>
        <div className="min-w-0 xl:col-span-4">
          <QuickActions />
        </div>
        <div className="min-w-0 xl:col-span-12">
          <ActivityFeed items={SAMPLE_ACTIVITY} />
        </div>
      </div>
    </>
  );
}
