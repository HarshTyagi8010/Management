import { useId, useState } from 'react';
import { Card, CardHeader, StatusBadge, cn, formatBusinessDate, formatINR, type StatusTone } from '@bizmgmt/ui';
import type { BusinessEvent, EventKind } from './sample-data';

const KIND: Record<EventKind, { label: string; tone: StatusTone }> = {
  payment_due: { label: 'Payment due', tone: 'info' },
  po_expected: { label: 'Delivery expected', tone: 'neutral' },
  task: { label: 'Follow-up', tone: 'success' },
};

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Calendar arithmetic on YYYY-MM-DD in UTC, so the user's timezone cannot shift business dates. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
}

export function FollowUpCalendar({ events, today }: { events: BusinessEvent[]; today: string }) {
  const headingId = useId();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 1));
  const [selected, setSelected] = useState<string | null>(null);
  const overdue = events.filter((e) => e.overdue);
  const visible = selected ? events.filter((e) => e.date === selected) : events.filter((e) => e.date >= today || e.overdue);

  return (
    <Card aria-labelledby={headingId} className="flex min-w-0 flex-col">
      <CardHeader
        id={headingId}
        title="Follow-ups"
        description={overdue.length ? `${overdue.length} overdue · ${events.length - overdue.length} upcoming` : `${events.length} upcoming`}
      />
      <div role="group" aria-label="Filter by day" className="mt-4 grid grid-cols-7 gap-1 px-4">
        {days.map((date) => {
          const count = events.filter((e) => e.date === date).length;
          const isToday = date === today;
          const isSelected = date === selected;
          return (
            <button
              key={date}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setSelected(isSelected ? null : date)}
              className={cn(
                'flex min-h-14 cursor-pointer flex-col items-center justify-center rounded-md border text-xs transition-colors',
                isSelected ? 'border-accent bg-accent text-accent-contrast' : isToday ? 'border-accent text-accent' : 'border-transparent hover:bg-surface-muted',
              )}
            >
              <span className={cn(!isSelected && 'text-muted')}>{weekday(date)}</span>
              <span className="tabular text-sm font-semibold">{date.slice(8)}</span>
              <span className="sr-only">
                {` ${MONTH[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}${isToday ? ', today' : ''}: ${count} item${count === 1 ? '' : 's'}`}
              </span>
              <span aria-hidden="true" className={cn('mt-0.5 size-1.5 rounded-full', count ? (isSelected ? 'bg-accent-contrast' : 'bg-accent') : 'bg-transparent')} />
            </button>
          );
        })}
      </div>
      <ul className="mt-3 flex-1 divide-y divide-border px-5 pb-2" aria-live="polite">
        {visible.length === 0 && <li className="py-6 text-center text-muted">Nothing scheduled for this day.</li>}
        {visible.map((e) => (
          <li key={e.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-3">
            <div className="min-w-0 flex-1 basis-40">
              <p className="font-medium break-words">{e.title}</p>
              <p className="text-xs text-muted">
                {e.party} · <span className="whitespace-nowrap">{formatBusinessDate(e.date)}</span>
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {e.overdue ? <StatusBadge tone="danger" label="Overdue" /> : <StatusBadge tone={KIND[e.kind].tone} label={KIND[e.kind].label} />}
              {e.amount && <span className="tabular text-xs font-medium">{formatINR(e.amount)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
