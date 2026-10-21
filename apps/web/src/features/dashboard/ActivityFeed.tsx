import { ArrowDownLeft, ClipboardCheck, FileText, Send, ShoppingCart } from 'lucide-react';
import { useId } from 'react';
import { Card, CardHeader, formatINR } from '@bizmgmt/ui';
import type { Activity, ActivityKind } from './sample-data';

const ICON: Record<ActivityKind, React.ReactNode> = {
  invoice_issued: <FileText size={16} />,
  receipt_posted: <ArrowDownLeft size={16} />,
  bill_posted: <ShoppingCart size={16} />,
  stock_adjusted: <ClipboardCheck size={16} />,
  quotation_sent: <Send size={16} />,
};

const timeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

export function ActivityFeed({ items }: { items: Activity[] }) {
  const headingId = useId();
  return (
    <Card aria-labelledby={headingId} className="min-w-0">
      <CardHeader id={headingId} title="Recent activity" description="Business transactions across your team" />
      <ol className="mt-3 px-5 pb-4">
        {items.map((a) => (
          <li key={a.id} className="flex gap-3 py-2.5">
            <span aria-hidden="true" className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-muted">
              {ICON[a.kind]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[0.8125rem]">{a.text}</p>
              <p className="mt-0.5 text-xs text-muted">
                {a.actor} · <time dateTime={a.at}>{timeFmt.format(new Date(a.at))}</time>
              </p>
            </div>
            {a.amount && <span className="tabular shrink-0 text-[0.8125rem] font-medium">{formatINR(a.amount)}</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
