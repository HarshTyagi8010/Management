import { Info } from 'lucide-react';
import { Popover } from 'radix-ui';
import type { ReactNode } from 'react';
import { formatINR, formatINRCompact } from '../format';

export interface KpiCardProps {
  label: string;
  /** Money as a decimal string from the server. */
  value: string;
  /** What exactly the figure means (financial-policy.md §9). Shown on demand. */
  definition: string;
  /** Freshness, e.g. "As of 19-10-2026 18:00". */
  asOf: string;
  icon?: ReactNode;
  footnote?: ReactNode;
}

export function KpiCard({ label, value, definition, asOf, icon, footnote }: KpiCardProps) {
  const exact = formatINR(value);
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon && (
            <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-md bg-accent-soft text-accent">
              {icon}
            </span>
          )}
          <h2 className="truncate text-[0.8125rem] font-medium text-muted">{label}</h2>
        </div>
        {/* A popover (not a tooltip) so the definition is reachable by touch and keyboard. */}
        <Popover.Root>
          <Popover.Trigger
            aria-label={`What is “${label}”?`}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm text-muted hover:bg-surface-muted"
          >
            <Info aria-hidden="true" size={16} />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              sideOffset={6}
              className="z-50 max-w-72 rounded-md border border-border bg-surface p-3 text-[0.8125rem] text-text shadow-card"
            >
              {definition}
              <Popover.Arrow className="fill-surface" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <p className="tabular mt-3 text-kpi font-semibold tracking-tight" title={exact}>
        <span aria-hidden="true">{formatINRCompact(value)}</span>
        <span className="sr-only">{exact}</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        <span className="tabular">{exact}</span> · {asOf}
      </p>
      {footnote && <div className="mt-3 text-xs text-muted">{footnote}</div>}
    </section>
  );
}
