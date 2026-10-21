import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  DOCUMENT_TYPE_LIST,
  DOCUMENT_TYPES,
  documentSeriesSchema,
  financialYear,
  formatDocumentNumber,
  gstRegistrationSchema,
  MAX_DOCUMENT_NUMBER_LENGTH,
  renderedPrefixLength,
  seriesCapacity,
  type DocumentSeries,
  type DocumentType,
  type LegalEntity,
} from '@bizmgmt/contracts';
import { Button, Card, Checkbox, DataTable, Dialog, EmptyState, FormField, InlineAlert, Input, Select, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, listOf, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { useEntityChoice } from './EntityPicker';

const todayFy = () => financialYear(new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10));

export function SeriesPage() {
  usePageTitle('Document series');
  const { entity, picker, state } = useEntityChoice();
  return (
    <>
      <PageHeader title="Document series" description="How documents are numbered. GST documents restart numbering every financial year (April–March) and may have at most 16 characters." />
      {state}
      {picker}
      {entity && <SeriesList entity={entity} />}
    </>
  );
}

function SeriesList({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const key = useTenantQueryKey('series', entity.id);
  const series = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/document-series?legalEntityId=${entity.id}`, { schema: listOf(documentSeriesSchema), signal }).then((r) => r.data) });
  const regs = useQuery({
    queryKey: useTenantQueryKey('legal-entities', entity.id, 'registrations'),
    queryFn: ({ signal }) => api(`/legal-entities/${entity.id}/registrations`, { schema: listOf(gstRegistrationSchema), signal }).then((r) => r.data),
  });
  const [editing, setEditing] = useState<DocumentSeries | 'new' | null>(null);
  const editable = canIn('settings.company', entity.id);
  const gstinOf = (id: string | null) => regs.data?.find((r) => r.id === id)?.gstin ?? '';

  const columns: Column<DocumentSeries>[] = [
    { key: 'type', header: 'Document', primary: true, render: (s) => <span className="font-medium">{DOCUMENT_TYPES[s.docType].label}</span> },
    { key: 'name', header: 'Series', render: (s) => s.name },
    { key: 'gstin', header: 'GSTIN', render: (s) => (s.gstRegistrationId ? <span className="font-mono">{gstinOf(s.gstRegistrationId)}</span> : 'Whole entity') },
    { key: 'example', header: 'Next number looks like', render: (s) => <span className="font-mono">{s.example}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (s) => (
        <span className="flex flex-wrap gap-1">
          {s.isDefault && <StatusBadge tone="info" label="Default" />}
          {!s.active && <StatusBadge tone="neutral" label="Inactive" />}
          {s.locked && <StatusBadge tone="neutral" label="In use" />}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (s) =>
        editable ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
            Edit
          </Button>
        ) : null,
    },
  ];

  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <h2 className="text-base font-semibold">Series for {entity.legalName}</h2>
        {editable && <Button onClick={() => setEditing('new')}>Add series</Button>}
      </div>
      <div className="py-4">
        {series.isPending ? (
          <Skeleton className="mx-5 h-32" />
        ) : series.isError ? (
          <InlineAlert className="mx-5">{errorMessage(series.error)}</InlineAlert>
        ) : (
          <DataTable caption="Document series" hideCaption columns={columns} rows={series.data} rowKey={(s) => s.id} empty={<EmptyState title="No series yet" description="Add a tax invoice series for each GSTIN before issuing invoices." />} />
        )}
      </div>
      {editing && <SeriesDialog entity={entity} series={editing === 'new' ? null : editing} registrations={regs.data ?? []} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function SeriesDialog({ entity, series, registrations, onClose }: { entity: LegalEntity; series: DocumentSeries | null; registrations: Array<{ id: string; gstin: string; registrationType: string }>; onClose: () => void }) {
  const [docType, setDocType] = useState<DocumentType>(series?.docType ?? 'tax_invoice');
  const [gstRegistrationId, setReg] = useState(series?.gstRegistrationId ?? registrations[0]?.id ?? '');
  const [name, setName] = useState(series?.name ?? 'Tax invoices');
  const [prefix, setPrefix] = useState(series?.prefix ?? 'INV/{FY}/');
  const [padding, setPadding] = useState(series?.padding ?? 4);
  const [startNumber, setStart] = useState(series?.startNumber ?? 1);
  const [isDefault, setDefault] = useState(series?.isDefault ?? false);
  const [active, setActive] = useState(series?.active ?? true);
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('series', entity.id);
  const perRegistration = DOCUMENT_TYPES[docType].scope === 'registration';
  const format = { prefix, padding };
  const capacity = seriesCapacity(format);
  const preview = capacity > 0 ? formatDocumentNumber(format, Math.min(startNumber, capacity), todayFy()) : '';
  const length = renderedPrefixLength(prefix) + Math.max(padding, String(startNumber).length);

  const save = useMutation({
    mutationFn: () =>
      series
        ? api(`/document-series/${series.id}`, { method: 'PATCH', body: { version: series.version, name, isDefault, active, ...(series.locked ? {} : { prefix, padding, startNumber }) }, schema: documentSeriesSchema })
        : api('/document-series', { method: 'POST', body: { legalEntityId: entity.id, gstRegistrationId: perRegistration ? gstRegistrationId || null : null, docType, name, prefix, padding, startNumber, isDefault }, schema: documentSeriesSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const locked = series?.locked ?? false;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={series ? `Edit ${series.name}` : 'Add document series'} description={locked ? 'Numbers have been issued from this series, so its format is fixed.' : undefined}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="flex flex-col gap-4"
      >
        {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
        {!series && (
          <FormField label="Document type" required>
            {(f) => (
              <Select {...f} value={docType} onChange={(e) => setDocType(e.target.value as DocumentType)}>
                {DOCUMENT_TYPE_LIST.map((t) => (
                  <option key={t} value={t}>
                    {DOCUMENT_TYPES[t].label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        )}
        {!series && perRegistration && (
          <FormField label="GST registration" required error={errors.gstRegistrationId} hint={registrations.length === 0 ? 'Add a GSTIN in Company & GST first' : undefined}>
            {(f) => (
              <Select {...f} value={gstRegistrationId} onChange={(e) => setReg(e.target.value)}>
                {registrations.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.gstin} ({r.registrationType})
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        )}
        <FormField label="Name" required error={errors.name}>
          {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label="Prefix" error={errors.prefix} hint="{FY} becomes 26-27" className="sm:col-span-3">
            {(f) => <Input {...f} value={prefix} onChange={(e) => setPrefix(e.target.value)} disabled={locked} className="font-mono" />}
          </FormField>
          <FormField label="Digits" required>
            {(f) => <Input {...f} type="number" min={1} max={10} value={padding} onChange={(e) => setPadding(Number(e.target.value) || 1)} disabled={locked} />}
          </FormField>
          <FormField label="Start at" required error={errors.startNumber} hint="Each financial year" className="sm:col-span-2">
            {(f) => <Input {...f} type="number" min={1} value={startNumber} onChange={(e) => setStart(Number(e.target.value) || 1)} disabled={locked} />}
          </FormField>
        </div>
        <div aria-live="polite" className="rounded-md border border-border bg-surface-muted p-3 text-sm">
          {capacity > 0 ? (
            <>
              First number: <span className="font-mono font-medium">{preview}</span> ({length} of {MAX_DOCUMENT_NUMBER_LENGTH} characters). Room for numbers up to {capacity.toLocaleString('en-IN')} a year.
            </>
          ) : (
            <span className="text-danger">This prefix and digit count can't fit in {MAX_DOCUMENT_NUMBER_LENGTH} characters.</span>
          )}
        </div>
        <Checkbox label="Default series for this document type" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} />
        {series && <Checkbox label="Active" description="Inactive series can't be chosen for new documents." checked={active} onChange={(e) => setActive(e.target.checked)} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || capacity === 0}>
            {save.isPending ? 'Saving…' : 'Save series'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
