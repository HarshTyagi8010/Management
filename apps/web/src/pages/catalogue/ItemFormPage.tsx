import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { isSac, ITEM_TYPE_LABELS, ITEM_TYPES, itemSchema, type Item, type ItemType } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, ErrorState, FormField, InlineAlert, Input, Select, Skeleton } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, useTenantQueryKey, useUnits } from '../../lib/queries';
import { useTaxClasses } from '../settings/TaxPage';
import { usePageTitle } from '../usePageTitle';
import { useCategories } from './ItemsPage';

type Form = {
  sku: string;
  name: string;
  description: string;
  type: ItemType;
  categoryId: string;
  baseUnitId: string;
  altUnits: Array<{ unitId: string; factor: string }>;
  hsnSac: string;
  taxClassId: string;
  salePrice: string;
  purchasePrice: string;
  reorderLevel: string;
};

const blank: Form = { sku: '', name: '', description: '', type: 'stock', categoryId: '', baseUnitId: '', altUnits: [], hsnSac: '', taxClassId: '', salePrice: '', purchasePrice: '', reorderLevel: '' };

const fromItem = (i: Item): Form => ({
  sku: i.sku,
  name: i.name,
  description: i.description,
  type: i.type,
  categoryId: i.categoryId ?? '',
  baseUnitId: i.baseUnitId,
  altUnits: i.altUnits.map((a) => ({ unitId: a.unitId, factor: a.factor })),
  hsnSac: i.hsnSac,
  taxClassId: i.taxClassId,
  salePrice: i.salePrice ?? '',
  purchasePrice: i.purchasePrice ?? '',
  reorderLevel: i.reorderLevel ?? '',
});

export function ItemFormPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const key = useTenantQueryKey('items', 'detail', id ?? 'new');
  const item = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/items/${id}`, { schema: itemSchema, signal }), enabled: !isNew });
  usePageTitle(isNew ? 'Add item' : (item.data?.name ?? 'Item'));
  if (!isNew && item.isPending) return <Skeleton className="h-64" />;
  if (!isNew && item.isError) return <Card><ErrorState title="Item not available" message={errorMessage(item.error)} /></Card>;
  return <ItemForm key={item.data?.version ?? 'new'} item={isNew ? null : (item.data ?? null)} />;
}

function ItemForm({ item }: { item: Item | null }) {
  const { can } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const itemsKey = useTenantQueryKey('items');
  const units = useUnits();
  const classes = useTaxClasses();
  const categories = useCategories();
  const [form, setForm] = useState<Form>(item ? fromItem(item) : blank);
  const editable = can('item.edit');
  const priceEditable = editable && can('price.edit');
  const showCost = can('price.view_cost');
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const kind = form.type === 'service' ? 'service' : 'goods';
  const classOptions = (classes.data ?? []).filter((c) => c.kind === kind && !c.archived);
  const liveUnits = (units.data ?? []).filter((u) => !u.archived);
  const baseCode = liveUnits.find((u) => u.id === form.baseUnitId)?.code ?? 'base unit';
  const hsnHint = form.type === 'service' ? 'SAC: 6 digits starting 99' : isSac(form.hsnSac) ? 'Codes starting 99 are for services' : 'HSN: 4, 6 or 8 digits (your turnover sets the minimum on invoices)';

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        description: form.description,
        type: form.type,
        categoryId: form.categoryId || null,
        baseUnitId: form.baseUnitId,
        altUnits: form.altUnits.filter((a) => a.unitId && a.factor),
        hsnSac: form.hsnSac,
        taxClassId: form.taxClassId,
        reorderLevel: form.type === 'stock' && form.reorderLevel ? form.reorderLevel : null,
        ...(priceEditable ? { salePrice: form.salePrice || null, purchasePrice: form.purchasePrice || null } : {}),
      };
      return item ? api(`/items/${item.id}`, { method: 'PATCH', body: { ...body, version: item.version }, schema: itemSchema }) : api('/items', { method: 'POST', body: { ...body, sku: form.sku }, schema: itemSchema });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      navigate(`/inventory/items/${saved.id}`, { replace: true });
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api(`/items/${item?.id}`, { method: 'PATCH', body: { version: item?.version, archived }, schema: itemSchema }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: itemsKey }),
  });
  const errors = fieldErrorsOf(save.error);

  return (
    <>
      <p className="text-sm">
        <Link to="/inventory/items" className="text-accent underline-offset-2 hover:underline">
          Items
        </Link>
      </p>
      <PageHeader title={item ? item.name : 'Add item'} description={item ? `Code ${item.sku}${item.archived ? ' · archived' : ''}` : undefined} />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2"
      >
        {save.isError && <InlineAlert className="xl:col-span-2">{errorMessage(save.error)}</InlineAlert>}
        {save.isSuccess && <InlineAlert tone="success" className="xl:col-span-2">Saved.</InlineAlert>}
        <fieldset disabled={!editable} className="contents">
          <Card>
            <CardHeader title="Basics" />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Name" required error={errors.name} className="sm:col-span-2">
                {(f) => <Input {...f} value={form.name} onChange={set('name')} />}
              </FormField>
              <FormField label="Item code (SKU)" required error={errors.sku} hint={item ? 'Can’t change after creation' : 'Letters, digits and . _ / -'}>
                {(f) => <Input {...f} value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value.toUpperCase() })} disabled={!!item} className="font-mono uppercase" />}
              </FormField>
              <FormField label="Type" required error={errors.type}>
                {(f) => (
                  <Select {...f} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ItemType, taxClassId: '' })}>
                    {ITEM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {ITEM_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField label="Category" error={errors.categoryId}>
                {(f) => (
                  <Select {...f} value={form.categoryId} onChange={set('categoryId')}>
                    <option value="">None</option>
                    {(categories.data ?? []).filter((c) => !c.archived).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField label="Description" error={errors.description} className="sm:col-span-2">
                {(f) => <Input {...f} value={form.description} onChange={set('description')} />}
              </FormField>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Tax" />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label={form.type === 'service' ? 'SAC' : 'HSN'} required error={errors.hsnSac} hint={hsnHint}>
                {(f) => <Input {...f} inputMode="numeric" maxLength={8} value={form.hsnSac} onChange={set('hsnSac')} className="font-mono" />}
              </FormField>
              <FormField label="Tax class" required error={errors.taxClassId} hint={classOptions.length === 0 ? `Add a tax class for ${kind} under Settings › Tax rates` : undefined}>
                {(f) => (
                  <Select {...f} value={form.taxClassId} onChange={set('taxClassId')}>
                    <option value="">Choose</option>
                    {classOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.treatment === 'taxable' ? (c.currentRate !== null ? ` (${c.currentRate}% today)` : ' (no rate yet)') : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Units" />
            <CardBody className="flex flex-col gap-4">
              <FormField label="Base unit" required error={errors.baseUnitId} hint="Stock is counted in this unit">
                {(f) => (
                  <Select {...f} value={form.baseUnitId} onChange={set('baseUnitId')}>
                    <option value="">Choose</option>
                    {liveUnits.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.code} · {u.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              {form.altUnits.map((a, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <FormField label={`Alternate unit ${i + 1}`} error={errors[`altUnits.${i}.unitId`]} className="min-w-40 flex-1">
                    {(f) => (
                      <Select {...f} value={a.unitId} onChange={(e) => setForm({ ...form, altUnits: form.altUnits.map((x, j) => (j === i ? { ...x, unitId: e.target.value } : x)) })}>
                        <option value="">Choose</option>
                        {liveUnits.filter((u) => u.id !== form.baseUnitId).map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.code}
                          </option>
                        ))}
                      </Select>
                    )}
                  </FormField>
                  <FormField label={`Contains (${baseCode})`} error={errors[`altUnits.${i}.factor`]} className="w-40">
                    {(f) => <Input {...f} inputMode="decimal" value={a.factor} onChange={(e) => setForm({ ...form, altUnits: form.altUnits.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)) })} />}
                  </FormField>
                  <Button variant="ghost" onClick={() => setForm({ ...form, altUnits: form.altUnits.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
              ))}
              {form.altUnits.length < 5 && (
                <div>
                  <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, altUnits: [...form.altUnits, { unitId: '', factor: '' }] })}>
                    Add alternate unit
                  </Button>
                </div>
              )}
              {form.type === 'stock' && (
                <FormField label={`Reorder level (${baseCode})`} error={errors.reorderLevel}>
                  {(f) => <Input {...f} inputMode="decimal" value={form.reorderLevel} onChange={set('reorderLevel')} />}
                </FormField>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Prices" description={priceEditable ? `Per ${baseCode}, before GST` : 'Changing prices needs the “Change prices” permission.'} />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Sale price (₹)" error={errors.salePrice}>
                {(f) => <Input {...f} inputMode="decimal" value={form.salePrice} onChange={set('salePrice')} disabled={!priceEditable} />}
              </FormField>
              {showCost && (
                <FormField label="Purchase price (₹)" error={errors.purchasePrice}>
                  {(f) => <Input {...f} inputMode="decimal" value={form.purchasePrice} onChange={set('purchasePrice')} disabled={!priceEditable} />}
                </FormField>
              )}
            </CardBody>
          </Card>
        </fieldset>
        {editable && (
          <div className="flex flex-wrap gap-2 xl:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : item ? 'Save item' : 'Add item'}
            </Button>
            {item && (
              <Button variant="secondary" onClick={() => archive.mutate(!item.archived)} disabled={archive.isPending}>
                {item.archived ? 'Restore item' : 'Archive item'}
              </Button>
            )}
          </div>
        )}
        {archive.isError && <InlineAlert className="xl:col-span-2">{errorMessage(archive.error)}</InlineAlert>}
      </form>
    </>
  );
}
