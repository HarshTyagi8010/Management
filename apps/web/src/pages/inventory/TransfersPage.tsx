import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { stockTransferSchema, type StockTransfer, type Warehouse } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, formatBusinessDate, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, downloadFile, newIdempotencyKey } from '../../lib/api';
import { errorMessage, fieldErrorsOf, pageSchemaOf, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { formatDateTimeIST } from '../../app/permissions';
import { usePageTitle } from '../usePageTitle';
import { DocLink, DocStatus, LinesEditor, newLine, qty, rupees, todayIST, unitCost, useWarehouses, warehouseLabel, type EditLine } from './shared';

export function TransfersPage() {
  usePageTitle('Transfers');
  const { can, tenantContext } = useSession();
  const header = (
    <PageHeader
      title="Transfers"
      description="Move stock between warehouses of the same business entity. Goods are in transit from dispatch until they are received."
      actions={
        can('stock.move') ? (
          <Button asChild>
            <Link to="/inventory/transfers/new">New transfer</Link>
          </Button>
        ) : undefined
      }
    />
  );
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('stock.view')) return <>{header}<Card className="mt-6"><PermissionDenied permission="stock.view" /></Card></>;
  return (
    <>
      {header}
      <TransferList />
    </>
  );
}

function TransferList() {
  const [status, setStatus] = useState('');
  const key = useTenantQueryKey('stock-transfers', status);
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (status) p.set('status', status);
      if (pageParam) p.set('cursor', pageParam);
      return api(`/stock-transfers?${p.toString()}`, { schema: pageSchemaOf(stockTransferSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const columns: Column<StockTransfer>[] = [
    { key: 'number', header: 'Transfer', primary: true, render: (t) => <DocLink to={`/inventory/transfers/${t.id}`}>{t.number}</DocLink> },
    { key: 'date', header: 'Date', render: (t) => <span className="tabular whitespace-nowrap">{formatBusinessDate(t.docDate)}</span> },
    { key: 'route', header: 'From → to', render: (t) => `${t.fromWarehouseName} → ${t.toWarehouseName}` },
    { key: 'lines', header: 'Items', align: 'end', render: (t) => <span className="tabular">{t.lines.length}</span> },
    { key: 'status', header: 'Status', render: (t) => <DocStatus status={t.status} /> },
  ];
  const data = rows.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card className="mt-6">
      <div className="px-5 pt-5">
        <FormField label="Status" className="w-full sm:w-56">
          {(f) => (
            <Select {...f} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="dispatched">In transit</option>
              <option value="received">Received</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          )}
        </FormField>
      </div>
      <div className="py-4">
        {rows.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : rows.isError ? (
          <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
        ) : (
          <DataTable caption="Transfers" hideCaption columns={columns} rows={data} rowKey={(t) => t.id} empty={<EmptyState title="No transfers" description="Transfers between your warehouses appear here." />} />
        )}
        {rows.hasNextPage && (
          <div className="px-5 pt-4">
            <Button variant="secondary" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
              Show older
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function TransferPage() {
  const { id = 'new' } = useParams();
  const key = useTenantQueryKey('stock-transfer', id);
  const transfer = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/stock-transfers/${id}`, { schema: stockTransferSchema, signal }),
    enabled: id !== 'new',
    // The transfer note is made by the worker shortly after dispatch: check back for a while.
    refetchInterval: (q) => {
      const t = q.state.data;
      const waiting = t && (t.status === 'dispatched' || t.status === 'received') && (!t.pdf || t.pdf.status === 'pending');
      return waiting && q.state.dataUpdateCount < 40 ? 3000 : false;
    },
  });
  usePageTitle(id === 'new' ? 'New transfer' : (transfer.data?.number ?? 'Transfer'));
  if (id === 'new') return <TransferEditor transfer={null} />;
  if (transfer.isPending) return <Skeleton className="h-64" />;
  if (transfer.isError) return <ErrorState message={errorMessage(transfer.error)} onRetry={() => void transfer.refetch()} />;
  return transfer.data.status === 'draft' ? <TransferEditor key={transfer.data.version} transfer={transfer.data} /> : <TransferView transfer={transfer.data} />;
}

function useTransferAction(transfer: StockTransfer) {
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('stock-transfer', transfer.id);
  return useMutation({
    mutationFn: (action: 'dispatch' | 'receive' | 'cancel') => api(`/stock-transfers/${transfer.id}/${action}`, { method: 'POST', body: { version: transfer.version }, schema: stockTransferSchema, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      void queryClient.invalidateQueries({ predicate: (q) => ['stock-transfers', 'stock-summary', 'stock-ledger'].includes(String(q.queryKey[2])) });
    },
  });
}

function TransferEditor({ transfer }: { transfer: StockTransfer | null }) {
  const { canInWarehouse } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const entities = useLegalEntities();
  const [entityId, setEntityId] = useState(transfer?.legalEntityId ?? '');
  const chosenEntity = entityId || entities.data?.[0]?.id || '';
  const warehouses = useWarehouses(chosenEntity || undefined);
  const live = (warehouses.data ?? []).filter((w) => !w.archived);
  const sources = live.filter((w) => canInWarehouse('stock.move', w));
  const [fromId, setFromId] = useState(transfer?.fromWarehouseId ?? '');
  const [toId, setToId] = useState(transfer?.toWarehouseId ?? '');
  const [docDate, setDocDate] = useState(transfer?.docDate ?? todayIST());
  const [note, setNote] = useState(transfer?.note ?? '');
  const [lines, setLines] = useState<EditLine[]>(transfer ? transfer.lines.map((l) => newLine({ itemId: l.itemId, qty: l.qty })) : [newLine()]);
  const source = fromId || sources[0]?.id || '';
  const save = useMutation({
    mutationFn: () => {
      const body = { toWarehouseId: toId, docDate, note, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) };
      return transfer
        ? api(`/stock-transfers/${transfer.id}`, { method: 'PATCH', body: { ...body, version: transfer.version }, schema: stockTransferSchema })
        : api('/stock-transfers', { method: 'POST', body: { ...body, fromWarehouseId: source }, schema: stockTransferSchema });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ predicate: (q) => ['stock-transfers', 'stock-transfer'].includes(String(q.queryKey[2])) });
      navigate(`/inventory/transfers/${saved.id}`, { replace: true });
    },
  });
  const action = useTransferAction(transfer ?? ({ id: 'none', version: 0 } as StockTransfer));
  const errors = fieldErrorsOf(save.error);
  const canEdit = transfer ? canInWarehouse('stock.move', { id: transfer.fromWarehouseId, legalEntityId: transfer.legalEntityId }) : sources.length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const header = <PageHeader title={transfer ? `Transfer ${transfer.number}` : 'New transfer'} description={transfer ? 'Draft: stock has not moved yet.' : 'Choose where the goods leave from and where they go.'} />;
  if (entities.isPending || warehouses.isPending) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!canEdit) return <>{header}<Card className="mt-6"><PermissionDenied permission="stock.move" /></Card></>;
  const destinations = live.filter((w) => w.id !== source);
  return (
    <>
      {header}
      <form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-6">
        {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
        {action.isError && <InlineAlert>{errorMessage(action.error)}</InlineAlert>}
        <Card>
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {!transfer && (entities.data?.length ?? 0) > 1 && (
              <FormField label="Business entity" className="sm:col-span-2">
                {(f) => (
                  <Select
                    {...f}
                    value={chosenEntity}
                    onChange={(e) => {
                      setEntityId(e.target.value);
                      setFromId('');
                      setToId('');
                    }}
                  >
                    {entities.data?.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.legalName}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            )}
            <FormField label="From warehouse" required error={errors.fromWarehouseId}>
              {(f) => <WarehouseSelect {...f} value={source} onChange={setFromId} options={sources} disabled={transfer !== null} />}
            </FormField>
            <FormField label="To warehouse" required error={errors.toWarehouseId}>
              {(f) => <WarehouseSelect {...f} value={toId} onChange={setToId} options={destinations} placeholder="Choose a warehouse" />}
            </FormField>
            <FormField label="Date" required error={errors.docDate}>
              {(f) => <Input {...f} type="date" max={todayIST()} value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
            </FormField>
            <FormField label="Note" error={errors.note} hint="Vehicle, person carrying, reason…">
              {(f) => <Input {...f} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
            </FormField>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <LinesEditor lines={lines} onChange={setLines} errors={errors} known={transfer?.lines.map((l) => ({ id: l.itemId, sku: l.sku, name: l.itemName, baseUnitCode: l.unitCode })) ?? []} />
          </CardBody>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : transfer ? 'Save draft' : 'Save as draft'}
          </Button>
          {transfer && (
            <>
              <Button variant="secondary" onClick={() => action.mutate('dispatch')} disabled={action.isPending}>
                Dispatch now
              </Button>
              <Button variant="ghost" onClick={() => action.mutate('cancel')} disabled={action.isPending}>
                Cancel transfer
              </Button>
            </>
          )}
        </div>
        {transfer && <p className="text-xs text-muted">Save your changes before dispatching. Dispatch takes the goods out of {transfer.fromWarehouseName}.</p>}
      </form>
    </>
  );
}

function WarehouseSelect({ value, onChange, options, placeholder, ...field }: { value: string; onChange: (id: string) => void; options: Warehouse[]; placeholder?: string; disabled?: boolean; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-required'?: true }) {
  return (
    <Select {...field} value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((w) => (
        <option key={w.id} value={w.id}>
          {warehouseLabel(w)}
        </option>
      ))}
    </Select>
  );
}

function TransferView({ transfer }: { transfer: StockTransfer }) {
  const { can, canInWarehouse } = useSession();
  const action = useTransferAction(transfer);
  const showCost = can('price.view_cost');
  const canReceive = transfer.status === 'dispatched' && canInWarehouse('stock.move', { id: transfer.toWarehouseId, legalEntityId: transfer.legalEntityId });
  const canReturn = transfer.status === 'dispatched' && canInWarehouse('stock.move', { id: transfer.fromWarehouseId, legalEntityId: transfer.legalEntityId });
  const download = useMutation({ mutationFn: () => downloadFile(`/stock-transfers/${transfer.id}/pdf`, `${transfer.number}.pdf`) });
  const note =
    transfer.status === 'draft' || transfer.status === 'cancelled' || !can('document.download') ? null : transfer.pdf?.status === 'ready' ? (
      <Button variant="secondary" onClick={() => download.mutate()} disabled={download.isPending}>
        {download.isPending ? 'Downloading…' : 'Download transfer note (PDF)'}
      </Button>
    ) : transfer.pdf?.status === 'failed' ? (
      <span className="text-sm text-danger">The transfer note could not be made.</span>
    ) : (
      <span className="text-sm text-muted" role="status">
        Preparing the transfer note…
      </span>
    );
  type Line = StockTransfer['lines'][number];
  const columns: Column<Line>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (l) => (
        <span className="flex flex-col">
          <span className="font-medium">{l.itemName}</span>
          <span className="font-mono text-xs text-muted">{l.sku}</span>
        </span>
      ),
    },
    { key: 'qty', header: 'Quantity', align: 'end', render: (l) => <span className="tabular whitespace-nowrap">{qty(l.qty)} <span className="text-xs text-muted">{l.unitCode}</span></span> },
    ...(showCost
      ? [
          { key: 'cost', header: 'Unit cost', align: 'end' as const, render: (l: Line) => <span className="tabular">{unitCost(l.unitCost)}</span> },
          { key: 'value', header: 'Value', align: 'end' as const, render: (l: Line) => <span className="tabular">{rupees(l.value)}</span> },
        ]
      : []),
  ];
  const events = [
    transfer.dispatchedAt && `Dispatched ${formatDateTimeIST(transfer.dispatchedAt)}${transfer.dispatchedBy ? ` by ${transfer.dispatchedBy.name}` : ''}`,
    transfer.receivedAt && `Received ${formatDateTimeIST(transfer.receivedAt)}${transfer.receivedBy ? ` by ${transfer.receivedBy.name}` : ''}`,
    transfer.cancelledAt && `Cancelled ${formatDateTimeIST(transfer.cancelledAt)}`,
  ].filter(Boolean);
  return (
    <>
      <PageHeader
        title={`Transfer ${transfer.number}`}
        description={`${transfer.fromWarehouseName} → ${transfer.toWarehouseName} · ${formatBusinessDate(transfer.docDate)}`}
        actions={
          <>
            {canReceive && (
              <Button onClick={() => action.mutate('receive')} disabled={action.isPending}>
                Receive goods
              </Button>
            )}
            {canReturn && (
              <Button variant="secondary" onClick={() => action.mutate('cancel')} disabled={action.isPending}>
                Cancel and return goods
              </Button>
            )}
          </>
        }
      />
      {action.isError && <InlineAlert className="mt-4">{errorMessage(action.error)}</InlineAlert>}
      {download.isError && <InlineAlert className="mt-4">{errorMessage(download.error)}</InlineAlert>}
      <Card className="mt-6">
        <CardHeader title="Status" description={events.join(' · ') || undefined} action={<DocStatus status={transfer.status} />} />
        {transfer.note && <CardBody className="text-sm">{transfer.note}</CardBody>}
        {note && <CardBody className="pt-3">{note}</CardBody>}
      </Card>
      <Card className="mt-6">
        <div className="py-4">
          <DataTable caption="Items transferred" columns={columns} rows={transfer.lines} rowKey={(l) => l.lineId} />
        </div>
      </Card>
    </>
  );
}
