import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { itemSchema, warehouseSchema, type CountStatus, type Item, type TransferStatus, type Warehouse } from '@bizmgmt/contracts';
import { Button, FormField, IconButton, Input, Select, StatusBadge, formatINR, formatQuantity, type StatusTone } from '@bizmgmt/ui';
import { Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { listOf, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';

/** Warehouses of one entity (or all the caller can see). */
export function useWarehouses(legalEntityId?: string) {
  const key = useTenantQueryKey('warehouses', legalEntityId ?? 'all');
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/warehouses${legalEntityId ? `?legalEntityId=${legalEntityId}` : ''}`, { schema: listOf(warehouseSchema), signal }).then((r) => r.data),
  });
}

/** Active stock items for pickers (first 100, alphabetical; search narrows). */
export function useStockItems(search: string) {
  const key = useTenantQueryKey('stock-items', search);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ type: 'stock', limit: '100' });
      if (search) params.set('q', search);
      return api(`/items?${params.toString()}`, { schema: pageSchemaOf(itemSchema), signal }).then((r) => r.data);
    },
  });
}

export const warehouseLabel = (w: Pick<Warehouse, 'code' | 'name'>) => `${w.code} · ${w.name}`;

/** Signed quantities show a real minus sign; values are rupees. */
export const qty = (value: string) => formatQuantity(value);
export const rupees = (value: string | null | undefined) => (value === null || value === undefined ? '—' : formatINR(value));
/** Unit costs have up to 6 decimals: show 2 when that is exact, otherwise all of them. */
export function unitCost(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const sign = value.startsWith('-') ? '−' : '';
  return trimmed.length <= 2 ? `${sign}${formatINR(`${whole}.${trimmed.padEnd(2, '0')}`)}` : `${sign}₹${whole}.${trimmed}`;
}

const DOC_TONES: Record<string, StatusTone> = { draft: 'neutral', posted: 'success', cancelled: 'danger', dispatched: 'info', received: 'success', counting: 'info', submitted: 'warning' };
const DOC_LABELS: Record<string, string> = { draft: 'Draft', posted: 'Posted', cancelled: 'Cancelled', dispatched: 'In transit', received: 'Received', counting: 'Counting', submitted: 'Ready to post' };
export function DocStatus({ status }: { status: 'draft' | 'posted' | 'cancelled' | TransferStatus | CountStatus }) {
  return <StatusBadge tone={DOC_TONES[status] ?? 'neutral'} label={DOC_LABELS[status] ?? status} />;
}

export function DocLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="font-mono font-medium text-accent underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

/** Today in IST as YYYY-MM-DD (the server refuses future dates). */
export const todayIST = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export interface EditLine {
  key: string;
  itemId: string;
  qty: string;
  unitCost: string;
}

let lineCounter = 0;
export const newLine = (partial: Partial<EditLine> = {}): EditLine => {
  lineCounter += 1;
  return { key: `l${lineCounter}`, itemId: '', qty: '', unitCost: '', ...partial };
};

/**
 * Editable item lines. Items come from a server search; a chosen item stays in
 * the list even when a later search would not show it.
 */
export function LinesEditor({
  lines,
  onChange,
  errors,
  costLabel,
  qtyLabel = 'Quantity',
  qtyHint,
  known = [],
}: {
  lines: EditLine[];
  onChange: (lines: EditLine[]) => void;
  errors: Record<string, string>;
  /** Shows a unit-cost column with this label. */
  costLabel?: string | undefined;
  qtyLabel?: string;
  qtyHint?: string | undefined;
  /** Items already on the document (names for existing lines). */
  known?: Array<Pick<Item, 'id' | 'sku' | 'name' | 'baseUnitCode'>>;
}) {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const items = useStockItems(search);
  const options = new Map<string, Pick<Item, 'id' | 'sku' | 'name' | 'baseUnitCode'>>();
  for (const i of known) options.set(i.id, i);
  for (const i of items.data ?? []) options.set(i.id, i);
  const set = (key: string, patch: Partial<EditLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-1 text-[0.8125rem] font-semibold">Items</legend>
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Find stock items" hint="Search by name or code, then choose them below." className="min-w-0 flex-1 sm:max-w-sm">
          {(f) => (
            <Input
              {...f}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setSearch(q.trim());
                }
              }}
            />
          )}
        </FormField>
        <Button variant="secondary" onClick={() => setSearch(q.trim())}>
          Search
        </Button>
      </div>
      {errors.lines && <p className="text-xs font-medium text-danger">{errors.lines}</p>}
      <ol className="flex flex-col gap-3">
        {lines.map((line, index) => {
          const n = index + 1;
          const unit = options.get(line.itemId)?.baseUnitCode;
          return (
            <li key={line.key} className="grid grid-cols-1 items-start gap-3 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] lg:grid-cols-[minmax(0,1fr)_9rem_10rem_auto]">
              <FormField label={`Item ${n}`} required error={errors[`lines.${index}.itemId`]}>
                {(f) => (
                  <Select {...f} value={line.itemId} onChange={(e) => set(line.key, { itemId: e.target.value })}>
                    <option value="">Choose an item</option>
                    {[...options.values()].map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.sku} · {i.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField label={`${qtyLabel} ${n}${unit ? ` (${unit})` : ''}`} required error={errors[`lines.${index}.qty`]} hint={index === 0 ? qtyHint : undefined}>
                {(f) => <Input {...f} inputMode="decimal" className="tabular" value={line.qty} onChange={(e) => set(line.key, { qty: e.target.value.trim() })} />}
              </FormField>
              {costLabel && (
                <FormField label={`${costLabel} ${n}`} error={errors[`lines.${index}.unitCost`]}>
                  {(f) => <Input {...f} inputMode="decimal" className="tabular" value={line.unitCost} onChange={(e) => set(line.key, { unitCost: e.target.value.trim() })} />}
                </FormField>
              )}
              <div className="sm:pt-6">
                <IconButton label={`Remove item ${n}`} icon={<Trash2 size={16} />} onClick={() => onChange(lines.filter((l) => l.key !== line.key))} disabled={lines.length === 1} />
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <Button variant="secondary" onClick={() => onChange([...lines, newLine()])} disabled={lines.length >= 200}>
          Add another item
        </Button>
      </div>
    </fieldset>
  );
}
