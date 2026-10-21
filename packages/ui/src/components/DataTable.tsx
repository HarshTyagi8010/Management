import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface Column<T> {
  key: string;
  header: string;
  /** Numeric columns are right-aligned with tabular figures. */
  align?: 'start' | 'end';
  render: (row: T) => ReactNode;
  /** Shown as the card title in the stacked (mobile) layout. */
  primary?: boolean;
}

export interface DataTableProps<T> {
  caption: string;
  /** Visually hide the caption when a card heading already describes the table. */
  hideCaption?: boolean;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
}

/**
 * A semantic table at ≥ md; below md each row becomes a stacked card so the
 * page never scrolls horizontally at 360 px (design-system.md §7).
 * Only one layout is displayed at a time, so assistive tech sees one copy.
 */
export function DataTable<T>({ caption, hideCaption, columns, rows, rowKey, empty }: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary);

  return (
    <>
      {/* When the table is wider than its card it scrolls; a named, focusable region lets keyboard users scroll it (WCAG 2.1.1). */}
      <div role="region" aria-label={caption} tabIndex={0} className="hidden overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:block">
        <table className="w-full border-collapse text-left">
          <caption className={cn('px-5 pb-2 text-left text-[0.8125rem] text-muted', hideCaption && 'sr-only')}>{caption}</caption>
          <thead>
            <tr className="border-y border-border bg-surface-muted">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={cn('px-5 py-2.5 text-xs font-medium text-muted', col.align === 'end' && 'text-right')}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-border last:border-b-0 hover:bg-surface-muted">
                {columns.map((col) => (
                  <td key={col.key} className={cn('px-5 py-3 align-middle', col.align === 'end' && 'tabular text-right')}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label={caption} className="divide-y divide-border border-t border-border md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} className="px-5 py-3">
            {primary && <div className="font-medium">{primary.render(row)}</div>}
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem]">
              {rest.map((col) => (
                <div key={col.key} className="contents">
                  <dt className="text-muted">{col.header}</dt>
                  <dd className={cn('min-w-0', col.align === 'end' && 'tabular text-right')}>{col.render(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
