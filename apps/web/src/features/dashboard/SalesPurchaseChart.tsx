import { useId, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Card, CardHeader, DataTable, formatINR, formatINRCompact } from '@bizmgmt/ui';
import type { MonthPoint } from './sample-data';

/**
 * Charts need numbers for geometry. Conversion happens here for drawing only;
 * every figure shown as text comes from the original decimal string.
 */
const toPlot = (value: string) => Number(value);

export function SalesPurchaseChart({ data }: { data: MonthPoint[] }) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  const latest = data.at(-1);
  const plotted = data.map((d) => ({ ...d, salesN: toPlot(d.sales), purchasesN: toPlot(d.purchases) }));

  return (
    <Card aria-labelledby={headingId} className="flex h-full min-w-0 flex-col">
      <CardHeader
        id={headingId}
        title="Sales vs purchases"
        description="Taxable value by month, excluding GST"
        action={
          <Button variant="secondary" size="sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'Show chart' : 'Show table'}
          </Button>
        }
      />
      {latest && (
        <p className="sr-only">
          Six months to {latest.label}. {latest.label}: sales {formatINR(latest.sales)}, purchases {formatINR(latest.purchases)}. Use “Show table” for all values.
        </p>
      )}
      {asTable ? (
        <div className="mt-4 pb-2">
          <DataTable
            caption="Sales and purchases by month"
            hideCaption
            rows={data}
            rowKey={(r) => r.month}
            columns={[
              { key: 'm', header: 'Month', primary: true, render: (r) => r.label },
              { key: 's', header: 'Sales', align: 'end', render: (r) => formatINR(r.sales) },
              { key: 'p', header: 'Purchases', align: 'end', render: (r) => formatINR(r.purchases) },
            ]}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col px-2 pt-4 pb-3" aria-hidden="true">
          <div className="flex gap-4 px-3 pb-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-[var(--bz-chart-1)]" /> Sales
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-[var(--bz-chart-2)]" /> Purchases
            </span>
          </div>
          <div className="min-h-64 flex-1">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 640, height: 256 }}>
              <BarChart accessibilityLayer={false} data={plotted} barGap={4} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--bz-border)" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--bz-text-muted)', fontSize: 12 }} />
                <YAxis
                  width={64}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--bz-text-muted)', fontSize: 12 }}
                  tickFormatter={(v: number) => formatINRCompact(String(Math.round(v)))}
                />
                <Tooltip
                  cursor={{ fill: 'var(--bz-surface-muted)' }}
                  contentStyle={{ background: 'var(--bz-surface)', border: '1px solid var(--bz-border)', borderRadius: 10, fontSize: 12 }}
                  formatter={(_v, name, item) => {
                    const row = item.payload as MonthPoint;
                    return [formatINR(name === 'Sales' ? row.sales : row.purchases), name];
                  }}
                />
                <Bar dataKey="salesN" name="Sales" fill="var(--bz-chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
                <Bar dataKey="purchasesN" name="Purchases" fill="var(--bz-chart-2)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}
