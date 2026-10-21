import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TAX_TREATMENT_LABELS, TAX_TREATMENTS, taxClassSchema, type TaxClass, type TaxTreatment } from '@bizmgmt/contracts';
import { Button, Card, Checkbox, DataTable, Dialog, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, listOf, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function useTaxClasses(enabled = true) {
  const key = useTenantQueryKey('tax-classes');
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api('/tax-classes', { schema: listOf(taxClassSchema), signal }).then((r) => r.data), enabled });
}

export function TaxPage() {
  usePageTitle('Tax rates');
  const { can, tenantContext } = useSession();
  const allowed = can('tax.view') || can('tax.manage') || can('item.edit');
  const classes = useTaxClasses(allowed);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const manage = can('tax.manage');

  const columns: Column<TaxClass>[] = [
    { key: 'name', header: 'Tax class', primary: true, render: (t) => <span className="font-medium">{t.name}</span> },
    { key: 'kind', header: 'For', render: (t) => (t.kind === 'goods' ? 'Goods' : 'Services') },
    { key: 'treatment', header: 'Treatment', render: (t) => TAX_TREATMENT_LABELS[t.treatment] + (t.reverseCharge ? ' · reverse charge' : '') },
    {
      key: 'rate',
      header: 'GST today',
      render: (t) =>
        t.treatment !== 'taxable' ? '—' : t.currentRate !== null ? <span className="tabular">{t.currentRate}%</span> : <StatusBadge tone="warning" label="No rate for today" />,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (t) => (
        <Button size="sm" variant="secondary" onClick={() => setOpen(t.id)} aria-label={`${manage ? 'Manage rates' : 'View rates'} for ${t.name}`}>
          {manage ? 'Manage rates' : 'View rates'}
        </Button>
      ),
    },
  ];

  const header = (
    <PageHeader
      title="Tax rates"
      description="Tax classes and their GST rates over time. BizMgmt ships no rates: add each rate with where it comes from (for example the notification), and check it with your tax adviser."
      actions={manage ? <Button onClick={() => setAdding(true)}>Add tax class</Button> : undefined}
    />
  );
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-40" /></>;
  if (!allowed) return <>{header}<Card className="mt-6"><PermissionDenied permission="tax.view" /></Card></>;

  const selected = classes.data?.find((t) => t.id === open);
  return (
    <>
      {header}
      <Card className="mt-6">
        <div className="py-4">
          {classes.isPending ? (
            <Skeleton className="mx-5 h-32" />
          ) : classes.isError ? (
            <ErrorState message={errorMessage(classes.error)} onRetry={() => void classes.refetch()} />
          ) : (
            <DataTable caption="Tax classes" hideCaption columns={columns} rows={classes.data} rowKey={(t) => t.id} empty={<EmptyState title="No tax classes yet" description="Create a class for each kind of goods or service you sell, then add its rate." />} />
          )}
        </div>
      </Card>
      {adding && <ClassDialog onClose={() => setAdding(false)} />}
      {selected && <RatesDialog taxClass={selected} manage={manage} onClose={() => setOpen(null)} />}
    </>
  );
}

function ClassDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'goods' | 'service'>('goods');
  const [treatment, setTreatment] = useState<TaxTreatment>('taxable');
  const [reverseCharge, setRcm] = useState(false);
  const [description, setDescription] = useState('');
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('tax-classes');
  const create = useMutation({
    mutationFn: () => api('/tax-classes', { method: 'POST', body: { name, kind, treatment, reverseCharge, description }, schema: taxClassSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
  });
  const errors = fieldErrorsOf(create.error);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add tax class">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="flex flex-col gap-4"
      >
        {create.isError && <InlineAlert>{errorMessage(create.error)}</InlineAlert>}
        <FormField label="Name" required error={errors.name} hint="For example “Fasteners” or “Repair services”">
          {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="For" required>
            {(f) => (
              <Select {...f} value={kind} onChange={(e) => setKind(e.target.value as 'goods' | 'service')}>
                <option value="goods">Goods</option>
                <option value="service">Services</option>
              </Select>
            )}
          </FormField>
          <FormField label="Treatment" required>
            {(f) => (
              <Select {...f} value={treatment} onChange={(e) => setTreatment(e.target.value as TaxTreatment)}>
                {TAX_TREATMENTS.map((t) => (
                  <option key={t} value={t}>
                    {TAX_TREATMENT_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
        {treatment === 'taxable' && (
          <Checkbox label="Reverse charge" description="Only for categories notified for reverse charge. The recipient pays the tax." checked={reverseCharge} onChange={(e) => setRcm(e.target.checked)} />
        )}
        <FormField label="Notes">
          {(f) => <Input {...f} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || name.trim().length < 2}>
            {create.isPending ? 'Saving…' : 'Add tax class'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RatesDialog({ taxClass, manage, onClose }: { taxClass: TaxClass; manage: boolean; onClose: () => void }) {
  const [effectiveFrom, setFrom] = useState('');
  const [effectiveTo, setTo] = useState('');
  const [gstRate, setRate] = useState('');
  const [cessRate, setCess] = useState('');
  const [sourceReference, setSource] = useState('');
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('tax-classes');
  const done = () => void queryClient.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: () =>
      api(`/tax-classes/${taxClass.id}/schedules`, {
        method: 'POST',
        body: { version: taxClass.version, effectiveFrom, effectiveTo: effectiveTo || null, gstRate: gstRate.trim(), cessRate: cessRate.trim() || null, sourceReference },
        schema: taxClassSchema,
      }),
    onSuccess: () => {
      setFrom('');
      setTo('');
      setRate('');
      setCess('');
      setSource('');
      done();
    },
  });
  const close = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => api(`/tax-classes/${taxClass.id}/schedules/${id}`, { method: 'PATCH', body: { version: taxClass.version, effectiveTo: to }, schema: taxClassSchema }),
    onSuccess: done,
  });
  const errors = fieldErrorsOf(add.error);
  const error = add.error ?? close.error;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Rates for ${taxClass.name}`} description={`${TAX_TREATMENT_LABELS[taxClass.treatment]} ${taxClass.kind === 'goods' ? 'goods' : 'services'}${taxClass.reverseCharge ? ', reverse charge' : ''}`} className="max-w-2xl">
      <div className="flex flex-col gap-5">
        {error && <InlineAlert>{errorMessage(error)}</InlineAlert>}
        {taxClass.treatment !== 'taxable' ? (
          <p className="text-sm">{TAX_TREATMENT_LABELS[taxClass.treatment]} supplies carry no GST rate.</p>
        ) : taxClass.schedules.length === 0 ? (
          <p className="text-sm text-muted">No rates yet. Invoices can't use this class until a rate covers the invoice date.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Rate history">
            {taxClass.schedules.map((s) => (
              <li key={s.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium">
                  <span className="tabular">{s.gstRate}% GST</span>
                  {s.cessRate && <span className="tabular"> + {s.cessRate}% cess</span>}
                  <span className="text-muted">
                    {' '}
                    · from {s.effectiveFrom} {s.effectiveTo ? `to ${s.effectiveTo}` : '(no end date)'}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  Source: {s.sourceReference} · added by {s.verifiedBy}
                </p>
                {manage && !s.effectiveTo && <EndRate onEnd={(to) => close.mutate({ id: s.id, to })} pending={close.isPending} />}
              </li>
            ))}
          </ul>
        )}
        {manage && taxClass.treatment === 'taxable' && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
            className="flex flex-col gap-4 border-t border-border pt-4"
          >
            <h3 className="text-sm font-semibold">Add a rate</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="GST rate (%)" required error={errors.gstRate} hint="Total GST; CGST and SGST are half each">
                {(f) => <Input {...f} inputMode="decimal" value={gstRate} onChange={(e) => setRate(e.target.value)} />}
              </FormField>
              <FormField label="Cess (%)" error={errors.cessRate} hint="Only if compensation cess applies">
                {(f) => <Input {...f} inputMode="decimal" value={cessRate} onChange={(e) => setCess(e.target.value)} />}
              </FormField>
              <FormField label="Effective from" required error={errors.effectiveFrom}>
                {(f) => <Input {...f} type="date" value={effectiveFrom} onChange={(e) => setFrom(e.target.value)} />}
              </FormField>
              <FormField label="Effective to" error={errors.effectiveTo}>
                {(f) => <Input {...f} type="date" value={effectiveTo} onChange={(e) => setTo(e.target.value)} />}
              </FormField>
            </div>
            <FormField label="Source" required error={errors.sourceReference} hint="Notification or circular number, or who confirmed it">
              {(f) => <Input {...f} value={sourceReference} onChange={(e) => setSource(e.target.value)} />}
            </FormField>
            <div>
              <Button type="submit" disabled={add.isPending || !gstRate || !effectiveFrom || sourceReference.trim().length < 5}>
                {add.isPending ? 'Adding…' : 'Add rate'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

function EndRate({ onEnd, pending }: { onEnd: (date: string) => void; pending: boolean }) {
  const [date, setDate] = useState('');
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <FormField label="End this rate on" className="w-48">
        {(f) => <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
      </FormField>
      <Button size="sm" variant="secondary" disabled={!date || pending} onClick={() => onEnd(date)}>
        Set end date
      </Button>
    </div>
  );
}
