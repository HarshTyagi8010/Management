import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { gstRegistrationSchema, warehouseSchema, type Address, type LegalEntity, type Warehouse } from '@bizmgmt/contracts';
import { Button, Card, Checkbox, DataTable, Dialog, EmptyState, ErrorState, FormField, InlineAlert, Input, Select, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { AddressFields, EMPTY_ADDRESS, errorsUnder, PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, listOf, useTenantQueryKey } from '../../lib/queries';
import { useEntityChoice } from '../settings/EntityPicker';
import { usePageTitle } from '../usePageTitle';
import { useWarehouses } from './shared';

export function WarehousesPage() {
  usePageTitle('Warehouses');
  const { entity, picker, state } = useEntityChoice();
  return (
    <>
      <PageHeader title="Warehouses" description="Godowns, shops and other places where you keep stock. Each belongs to one business entity." />
      {state}
      {picker}
      {entity && <WarehouseList key={entity.id} entity={entity} />}
    </>
  );
}

function useRegistrations(entityId: string) {
  const key = useTenantQueryKey('registrations', entityId);
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/legal-entities/${entityId}/registrations`, { schema: listOf(gstRegistrationSchema), signal }).then((r) => r.data) });
}

function WarehouseList({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const editable = canIn('settings.company', entity.id);
  const warehouses = useWarehouses(entity.id);
  const registrations = useRegistrations(entity.id);
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const gstin = (id: string | null) => registrations.data?.find((r) => r.id === id)?.gstin ?? '—';
  const columns: Column<Warehouse>[] = [
    {
      key: 'name',
      header: 'Warehouse',
      primary: true,
      render: (w) => (
        <span className="flex flex-col">
          <span className="font-medium">{w.name}</span>
          <span className="font-mono text-xs text-muted">{w.code}</span>
        </span>
      ),
    },
    { key: 'place', header: 'Place', render: (w) => (w.address ? `${w.address.city}, ${w.address.stateCode}` : '—') },
    { key: 'gstin', header: 'GSTIN', render: (w) => <span className="font-mono">{gstin(w.gstRegistrationId)}</span> },
    { key: 'status', header: 'Status', render: (w) => <StatusBadge tone={w.archived ? 'neutral' : 'success'} label={w.archived ? 'Archived' : 'In use'} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (w) => (
        <span className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link to={`/inventory/stock?entity=${entity.id}&warehouse=${w.id}`} aria-label={`View stock in ${w.name}`}>
              View stock
            </Link>
          </Button>
          {editable && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(w)} aria-label={`Edit ${w.name}`}>
              Edit
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <h2 className="text-base font-semibold">Warehouses of {entity.legalName}</h2>
        {editable && <Button onClick={() => setEditing('new')}>Add warehouse</Button>}
      </div>
      <div className="py-4">
        {warehouses.isPending ? (
          <Skeleton className="mx-5 h-32" />
        ) : warehouses.isError ? (
          <ErrorState message={errorMessage(warehouses.error)} onRetry={() => void warehouses.refetch()} />
        ) : (
          <DataTable
            caption="Warehouses"
            hideCaption
            columns={columns}
            rows={warehouses.data}
            rowKey={(w) => w.id}
            empty={<EmptyState title="No warehouses yet" description="Add your godown or shop, then enter its opening stock." />}
          />
        )}
      </div>
      {editing && <WarehouseDialog entity={entity} warehouse={editing === 'new' ? null : editing} registrations={registrations.data ?? []} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function WarehouseDialog({ entity, warehouse, registrations, onClose }: { entity: LegalEntity; warehouse: Warehouse | null; registrations: Array<{ id: string; gstin: string; label: string }>; onClose: () => void }) {
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('warehouses');
  const [code, setCode] = useState(warehouse?.code ?? '');
  const [name, setName] = useState(warehouse?.name ?? '');
  const [registrationId, setRegistrationId] = useState(warehouse?.gstRegistrationId ?? '');
  const [hasAddress, setHasAddress] = useState(warehouse ? warehouse.address !== null : false);
  const [address, setAddress] = useState<Address>(warehouse?.address ?? { ...EMPTY_ADDRESS, stateCode: entity.address.stateCode });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: () => {
      const body = { name, gstRegistrationId: registrationId || null, address: hasAddress ? address : null };
      return warehouse
        ? api(`/warehouses/${warehouse.id}`, { method: 'PATCH', body: { ...body, version: warehouse.version }, schema: warehouseSchema })
        : api('/warehouses', { method: 'POST', body: { ...body, legalEntityId: entity.id, code }, schema: warehouseSchema });
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: () => api(`/warehouses/${warehouse?.id}`, { method: 'PATCH', body: { version: warehouse?.version, archived: !warehouse?.archived }, schema: warehouseSchema }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={warehouse ? `Edit ${warehouse.name}` : 'Add warehouse'} description={entity.legalName} className="max-w-2xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        {(save.isError || archive.isError) && <InlineAlert>{errorMessage(save.error ?? archive.error)}</InlineAlert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <FormField label="Code" required error={errors.code} hint={warehouse ? 'Codes can’t change' : 'Short, e.g. MAIN'}>
            {(f) => <Input {...f} value={code} maxLength={12} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={warehouse !== null} className="font-mono" />}
          </FormField>
          <FormField label="Name" required error={errors.name}>
            {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
        </div>
        <FormField label="GST registration" error={errors.gstRegistrationId} hint="The place of business this warehouse is registered under, if any.">
          {(f) => (
            <Select {...f} value={registrationId} onChange={(e) => setRegistrationId(e.target.value)}>
              <option value="">None</option>
              {registrations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.gstin}
                  {r.label ? ` · ${r.label}` : ''}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <Checkbox label="Record an address" checked={hasAddress} onChange={(e) => setHasAddress(e.target.checked)} />
        {hasAddress && <AddressFields value={address} onChange={setAddress} errors={errorsUnder(errors, 'address')} />}
        <div className="flex flex-wrap justify-between gap-2">
          {warehouse ? (
            <Button variant="ghost" onClick={() => archive.mutate()} disabled={archive.isPending}>
              {warehouse.archived ? 'Bring back into use' : 'Archive warehouse'}
            </Button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : warehouse ? 'Save' : 'Add warehouse'}
            </Button>
          </span>
        </div>
      </form>
    </Dialog>
  );
}
