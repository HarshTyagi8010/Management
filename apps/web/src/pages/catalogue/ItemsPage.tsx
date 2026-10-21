import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { categorySchema, ITEM_TYPE_LABELS, itemSchema, UQC_CODES, UQC_LIST, unitSchema, type Category, type Item, type Unit, type Uqc } from '@bizmgmt/contracts';
import { Button, Card, DataTable, Dialog, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, StatusBadge, formatINR, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, listOf, pageSchemaOf, useTenantQueryKey, useUnits } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

const tabTrigger = 'inline-flex h-10 cursor-pointer items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted data-[state=active]:border-accent data-[state=active]:text-text';

/** Unit prices may have up to 6 decimals; show rupees with 2 when they fit, otherwise the exact value. */
export function formatPrice(price: string | null | undefined): string {
  if (price === null || price === undefined) return '—';
  const [whole = '0', fraction = ''] = price.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length <= 2 ? formatINR(`${whole}.${trimmed.padEnd(2, '0')}`) : `₹${price}`;
}

export function useCategories(enabled = true) {
  const key = useTenantQueryKey('categories');
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api('/categories', { schema: listOf(categorySchema), signal }).then((r) => r.data), enabled });
}

export function ItemsPage() {
  usePageTitle('Items');
  const { can, tenantContext } = useSession();
  const header = (
    <PageHeader
      title="Items"
      description="Products and services you buy and sell, with their HSN/SAC codes, units and tax classes."
      actions={
        can('item.edit') ? (
          <Button asChild>
            <Link to="/inventory/items/new">Add item</Link>
          </Button>
        ) : undefined
      }
    />
  );
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('item.view')) return <>{header}<Card className="mt-6"><PermissionDenied permission="item.view" /></Card></>;
  return (
    <>
      {header}
      <Tabs.Root defaultValue="items" className="mt-6">
        <Tabs.List aria-label="Catalogue" className="flex gap-1 overflow-x-auto border-b border-border">
          <Tabs.Trigger value="items" className={tabTrigger}>
            Items
          </Tabs.Trigger>
          <Tabs.Trigger value="categories" className={tabTrigger}>
            Categories
          </Tabs.Trigger>
          <Tabs.Trigger value="units" className={tabTrigger}>
            Units
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="items" className="mt-4 focus:outline-none">
          <ItemList />
        </Tabs.Content>
        <Tabs.Content value="categories" className="mt-4 focus:outline-none">
          <CategoriesTab />
        </Tabs.Content>
        <Tabs.Content value="units" className="mt-4 focus:outline-none">
          <UnitsTab />
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}

function ItemList() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const key = useTenantQueryKey('items', search, archived);
  const items = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '50', archived: String(archived) });
      if (search) params.set('q', search);
      if (pageParam) params.set('cursor', pageParam);
      return api(`/items?${params.toString()}`, { schema: pageSchemaOf(itemSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const showCost = can('price.view_cost');
  const columns: Column<Item>[] = [
    {
      key: 'name',
      header: 'Item',
      primary: true,
      render: (i) => (
        <span className="flex flex-col">
          <Link to={`/inventory/items/${i.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
            {i.name}
          </Link>
          <span className="font-mono text-xs text-muted">{i.sku}</span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', render: (i) => ITEM_TYPE_LABELS[i.type] },
    { key: 'hsn', header: 'HSN/SAC', render: (i) => <span className="font-mono">{i.hsnSac}</span> },
    { key: 'unit', header: 'Unit', render: (i) => i.baseUnitCode },
    { key: 'tax', header: 'Tax class', render: (i) => i.taxClassName },
    { key: 'price', header: 'Sale price', align: 'end', render: (i) => <span className="tabular">{formatPrice(i.salePrice)}</span> },
    ...(showCost ? [{ key: 'cost', header: 'Cost', align: 'end' as const, render: (i: Item) => <span className="tabular">{formatPrice(i.purchasePrice)}</span> }] : []),
  ];
  const rows = items.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card>
      <form
        role="search"
        className="flex flex-wrap items-end gap-3 px-5 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <FormField label="Search by name, code or HSN" className="min-w-0 flex-1 sm:max-w-sm">
          {(f) => <Input {...f} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
        </FormField>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="size-4 accent-accent" />
          Show archived
        </label>
      </form>
      <div className="py-4">
        {items.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : items.isError ? (
          <ErrorState message={errorMessage(items.error)} onRetry={() => void items.refetch()} />
        ) : (
          <DataTable caption="Items" hideCaption columns={columns} rows={rows} rowKey={(i) => i.id} empty={<EmptyState title={search ? 'No matching items' : 'No items yet'} description={search ? 'Try another name or code.' : 'Add your products and services. You need a tax class first.'} />} />
        )}
      </div>
      {items.hasNextPage && (
        <div className="flex justify-center px-5 pb-5">
          <Button variant="secondary" onClick={() => void items.fetchNextPage()} disabled={items.isFetchingNextPage}>
            {items.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      )}
    </Card>
  );
}

function CategoriesTab() {
  const { can } = useSession();
  const categories = useCategories();
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('categories');
  const add = useMutation({
    mutationFn: () => api('/categories', { method: 'POST', body: { name }, schema: categorySchema }),
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const columns: Column<Category>[] = [
    { key: 'name', header: 'Category', primary: true, render: (c) => c.name },
    { key: 'count', header: 'Items', align: 'end', render: (c) => <span className="tabular">{c.itemCount}</span> },
  ];
  return (
    <Card>
      {can('item.edit') && (
        <form
          noValidate
          className="flex flex-wrap items-end gap-3 px-5 pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <FormField label="New category" className="min-w-0 flex-1 sm:max-w-sm" error={fieldErrorsOf(add.error).name}>
            {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <Button type="submit" disabled={add.isPending || !name.trim()}>
            Add
          </Button>
        </form>
      )}
      <div className="py-4">
        {categories.isPending ? <Skeleton className="mx-5 h-24" /> : categories.isError ? <InlineAlert className="mx-5">{errorMessage(categories.error)}</InlineAlert> : <DataTable caption="Categories" hideCaption columns={columns} rows={categories.data} rowKey={(c) => c.id} empty={<EmptyState title="No categories yet" />} />}
      </div>
    </Card>
  );
}

function UnitsTab() {
  const { can } = useSession();
  const units = useUnits();
  const [adding, setAdding] = useState(false);
  const columns: Column<Unit>[] = [
    { key: 'code', header: 'Code', primary: true, render: (u) => <span className="font-mono font-medium">{u.code}</span> },
    { key: 'name', header: 'Name', render: (u) => u.name },
    { key: 'uqc', header: 'GST unit (UQC)', render: (u) => `${u.uqc} · ${UQC_CODES[u.uqc]}` },
    { key: 'decimals', header: 'Decimals', align: 'end', render: (u) => <span className="tabular">{u.decimals}</span> },
    { key: 'status', header: 'Status', render: (u) => (u.archived ? <StatusBadge tone="neutral" label="Archived" /> : null) },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <p className="text-sm text-muted">Each unit maps to a GST Unit Quantity Code (UQC) printed on invoices.</p>
        {can('item.edit') && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add unit
          </Button>
        )}
      </div>
      <div className="py-4">
        {units.isPending ? <Skeleton className="mx-5 h-24" /> : units.isError ? <InlineAlert className="mx-5">{errorMessage(units.error)}</InlineAlert> : <DataTable caption="Units" hideCaption columns={columns} rows={units.data} rowKey={(u) => u.id} />}
      </div>
      {adding && <UnitDialog onClose={() => setAdding(false)} />}
    </Card>
  );
}

function UnitDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [uqc, setUqc] = useState<Uqc>('NOS');
  const [decimals, setDecimals] = useState(0);
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('units');
  const add = useMutation({
    mutationFn: () => api('/units', { method: 'POST', body: { code, name, uqc, decimals }, schema: unitSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
  });
  const errors = fieldErrorsOf(add.error);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add unit">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
        className="flex flex-col gap-4"
      >
        {add.isError && <InlineAlert>{errorMessage(add.error)}</InlineAlert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Code" required error={errors.code} hint="Up to 8 letters or digits">
            {(f) => <Input {...f} value={code} maxLength={8} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono uppercase" />}
          </FormField>
          <FormField label="Name" required error={errors.name}>
            {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label="GST unit (UQC)" required>
            {(f) => (
              <Select {...f} value={uqc} onChange={(e) => setUqc(e.target.value as Uqc)}>
                {UQC_LIST.map((c) => (
                  <option key={c} value={c}>
                    {c} · {UQC_CODES[c]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Decimal places" required hint="0 for whole units">
            {(f) => (
              <Select {...f} value={decimals} onChange={(e) => setDecimals(Number(e.target.value))}>
                {[0, 1, 2, 3].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={add.isPending || !code || !name}>
            Add unit
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
