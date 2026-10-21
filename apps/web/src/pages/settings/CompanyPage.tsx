import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  CONSTITUTION_LABELS,
  CONSTITUTIONS,
  LOGO_MAX_BYTES,
  gstinProblem,
  gstRegistrationSchema,
  legalEntitySchema,
  stateName,
  TURNOVER_BAND_LABELS,
  TURNOVER_BANDS,
  turnoverRules,
  type Address,
  type GstRegistration,
  type LegalEntity,
  type TurnoverBand,
} from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, ErrorState, FormField, InlineAlert, Input, Select, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { AddressFields, EMPTY_ADDRESS, errorsUnder, PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, listOf, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

type EntityForm = { legalName: string; tradeName: string; pan: string; constitution: (typeof CONSTITUTIONS)[number]; turnoverBand: TurnoverBand; email: string; phone: string; address: Address };

const emptyEntity: EntityForm = { legalName: '', tradeName: '', pan: '', constitution: 'proprietorship', turnoverBand: 'up_to_5cr', email: '', phone: '', address: EMPTY_ADDRESS };

export function CompanyPage() {
  usePageTitle('Company & GST');
  const entities = useLegalEntities();
  const { tenantContext } = useSession();
  const [adding, setAdding] = useState(false);
  const canCreate = tenantContext?.entityScopes['settings.company'] === 'all';

  return (
    <>
      <PageHeader
        title="Company & GST"
        description="Your business entities (one per PAN) and their GST registrations."
        actions={canCreate ? <Button onClick={() => setAdding(true)}>Add business entity</Button> : undefined}
      />
      <div className="mt-6">
        {entities.isPending ? (
          <Skeleton className="h-40" />
        ) : entities.isError ? (
          <Card>
            <ErrorState message={errorMessage(entities.error)} onRetry={() => void entities.refetch()} />
          </Card>
        ) : entities.data.length === 0 ? (
          <Card>
            <EmptyState
              title="Add your business entity"
              description="Enter the legal name and PAN of the business that issues invoices, then add its GSTIN. You need this before you can set up document numbering."
              action={canCreate ? <Button onClick={() => setAdding(true)}>Add business entity</Button> : undefined}
            />
          </Card>
        ) : (
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Business entities">
            {entities.data.map((e) => (
              <li key={e.id}>
                <Card className="h-full">
                  <CardBody>
                    <Link to={`/settings/company/${e.id}`} className="text-base font-semibold text-accent underline-offset-2 hover:underline">
                      {e.legalName}
                    </Link>
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      <dt className="text-muted">PAN</dt>
                      <dd className="font-mono">{e.pan}</dd>
                      <dt className="text-muted">GST registrations</dt>
                      <dd>{e.registrationCount === 0 ? <StatusBadge tone="warning" label="None yet" /> : e.registrationCount}</dd>
                      <dt className="text-muted">Turnover band</dt>
                      <dd>{TURNOVER_BAND_LABELS[e.turnoverBand]}</dd>
                      <dt className="text-muted">Place</dt>
                      <dd>
                        {e.address.city}, {stateName(e.address.stateCode)}
                      </dd>
                    </dl>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
      {adding && <NewEntityDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function EntityFields({ value, onChange, errors, panLocked }: { value: EntityForm; onChange: (v: EntityForm) => void; errors: Record<string, string>; panLocked?: boolean }) {
  const set = (key: keyof EntityForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [key]: e.target.value });
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Legal name" required error={errors.legalName} className="sm:col-span-2" hint="As on the PAN and GST certificates">
          {(f) => <Input {...f} value={value.legalName} onChange={set('legalName')} />}
        </FormField>
        <FormField label="Trade name" error={errors.tradeName}>
          {(f) => <Input {...f} value={value.tradeName} onChange={set('tradeName')} />}
        </FormField>
        <FormField label="PAN" required error={errors.pan} hint={panLocked ? 'Can’t change while GST registrations exist' : '10 characters, like ABCDE1234F'}>
          {(f) => <Input {...f} value={value.pan} onChange={(e) => onChange({ ...value, pan: e.target.value.toUpperCase() })} maxLength={10} className="font-mono uppercase" disabled={panLocked} />}
        </FormField>
        <FormField label="Constitution" required error={errors.constitution}>
          {(f) => (
            <Select {...f} value={value.constitution} onChange={set('constitution')}>
              {CONSTITUTIONS.map((c) => (
                <option key={c} value={c}>
                  {CONSTITUTION_LABELS[c]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Aggregate turnover (declared)" required error={errors.turnoverBand} hint="Previous financial year, all GSTINs under this PAN">
          {(f) => (
            <Select {...f} value={value.turnoverBand} onChange={set('turnoverBand')}>
              {TURNOVER_BANDS.map((b) => (
                <option key={b} value={b}>
                  {TURNOVER_BAND_LABELS[b]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Email" error={errors.email}>
          {(f) => <Input {...f} type="email" value={value.email} onChange={set('email')} />}
        </FormField>
        <FormField label="Phone" error={errors.phone}>
          {(f) => <Input {...f} type="tel" value={value.phone} onChange={set('phone')} />}
        </FormField>
      </div>
      <AddressFields legend="Registered address" value={value.address} onChange={(address) => onChange({ ...value, address })} errors={errorsUnder(errors, 'address')} />
    </div>
  );
}

function NewEntityDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState(emptyEntity);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const key = useTenantQueryKey('legal-entities');
  const create = useMutation({
    mutationFn: () => api('/legal-entities', { method: 'POST', body: form, schema: legalEntitySchema }),
    onSuccess: (entity) => {
      void queryClient.invalidateQueries({ queryKey: key });
      onClose();
      navigate(`/settings/company/${entity.id}`);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add business entity" description="A business entity is one PAN. Add its GST registrations next." className="max-w-2xl">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="flex flex-col gap-5"
      >
        {create.isError && <InlineAlert>{errorMessage(create.error)}</InlineAlert>}
        <EntityFields value={form} onChange={setForm} errors={fieldErrorsOf(create.error)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Add business entity'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ detail

export function EntityPage() {
  const { id = '' } = useParams();
  const key = useTenantQueryKey('legal-entities', id);
  const entity = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/legal-entities/${id}`, { schema: legalEntitySchema, signal }) });
  usePageTitle(entity.data?.legalName ?? 'Business entity');

  if (entity.isPending) return <Skeleton className="h-64" />;
  if (entity.isError) {
    return (
      <Card>
        <ErrorState title="Business entity not available" message={errorMessage(entity.error)} />
      </Card>
    );
  }
  return (
    <>
      <p className="text-sm">
        <Link to="/settings/company" className="text-accent underline-offset-2 hover:underline">
          Company & GST
        </Link>
      </p>
      <PageHeader title={entity.data.legalName} description={`PAN ${entity.data.pan}`} />
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ComplianceCard entity={entity.data} />
        <RegistrationsCard entity={entity.data} />
        <DetailsCard key={entity.data.version} entity={entity.data} />
        <BankAccountsCard key={`b${entity.data.version}`} entity={entity.data} />
        <LogoCard entity={entity.data} />
      </div>
    </>
  );
}

function useEntitySaved(id: string) {
  const queryClient = useQueryClient();
  const listKey = useTenantQueryKey('legal-entities');
  return (entity: LegalEntity) => {
    queryClient.setQueryData([...listKey, id], entity);
    void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
  };
}

function ComplianceCard({ entity }: { entity: LegalEntity }) {
  const rules = turnoverRules(entity.turnoverBand);
  return (
    <Card>
      <CardHeader title="GST rules from your turnover" description={`Declared: ${TURNOVER_BAND_LABELS[entity.turnoverBand]}. Update it when your turnover changes.`} />
      <CardBody className="flex flex-col gap-3 text-sm">
        <p>
          <strong>HSN/SAC on tax invoices:</strong> at least {rules.hsnMinDigits} digits.
        </p>
        {rules.eInvoiceApplicable ? (
          <InlineAlert tone="warning">
            E-invoicing applies to this business. BizMgmt does not generate e-invoices (IRN) yet, and its PDFs are not e-invoices. Report B2B invoices on the IRP
            {rules.irpThirtyDayLimit ? ' within 30 days of the invoice date' : ''}.
          </InlineAlert>
        ) : (
          <p className="text-muted">E-invoicing does not apply at this turnover band.</p>
        )}
        <p className="text-xs text-muted">Based on the rules recorded in the compliance notes (gst.md GST-04, 06, 07). Not legal advice; confirm with your tax adviser.</p>
      </CardBody>
    </Card>
  );
}

function DetailsCard({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const editable = canIn('settings.company', entity.id);
  const [form, setForm] = useState<EntityForm>({ ...entity, constitution: entity.constitution });
  const saved = useEntitySaved(entity.id);
  const save = useMutation({
    mutationFn: () => api(`/legal-entities/${entity.id}`, { method: 'PATCH', body: { ...form, ...(entity.registrationCount > 0 ? { pan: undefined } : {}), version: entity.version }, schema: legalEntitySchema }),
    onSuccess: saved,
  });
  return (
    <Card className="xl:col-span-2">
      <CardHeader title="Details" />
      <CardBody>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="flex flex-col gap-5"
        >
          {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
          {save.isSuccess && <InlineAlert tone="success">Saved.</InlineAlert>}
          <fieldset disabled={!editable} className="contents">
            <EntityFields value={form} onChange={setForm} errors={fieldErrorsOf(save.error)} panLocked={entity.registrationCount > 0} />
          </fieldset>
          {editable && (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save details'}
              </Button>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function RegistrationsCard({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const key = useTenantQueryKey('legal-entities', entity.id, 'registrations');
  const regs = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/legal-entities/${entity.id}/registrations`, { schema: listOf(gstRegistrationSchema), signal }).then((r) => r.data) });
  const [adding, setAdding] = useState(false);
  const editable = canIn('settings.company', entity.id);
  const columns: Column<GstRegistration>[] = [
    {
      key: 'gstin',
      header: 'GSTIN',
      primary: true,
      render: (r) => (
        <span className="flex flex-col">
          <span className="font-mono">{r.gstin}</span>
          {r.label && <span className="text-xs text-muted">{r.label}</span>}
        </span>
      ),
    },
    { key: 'state', header: 'State', render: (r) => `${r.stateCode} · ${stateName(r.stateCode) ?? ''}` },
    { key: 'type', header: 'Type', render: (r) => (r.registrationType === 'regular' ? 'Regular' : 'Composition') },
    { key: 'from', header: 'Effective', render: (r) => <span className="tabular whitespace-nowrap">{r.effectiveFrom}{r.effectiveTo ? ` to ${r.effectiveTo}` : ''}</span> },
  ];
  return (
    <Card>
      <CardHeader title="GST registrations" description="One per state where you are registered." action={editable ? <Button size="sm" onClick={() => setAdding(true)}>Add GSTIN</Button> : undefined} />
      <div className="py-4">
        {regs.isPending ? (
          <Skeleton className="mx-5 h-24" />
        ) : regs.isError ? (
          <InlineAlert className="mx-5">{errorMessage(regs.error)}</InlineAlert>
        ) : (
          <DataTable caption="GST registrations" hideCaption columns={columns} rows={regs.data} rowKey={(r) => r.id} empty={<EmptyState title="No GST registration yet" description="Add the GSTIN to issue tax invoices. Unregistered businesses can skip this." />} />
        )}
      </div>
      {adding && <RegistrationDialog entity={entity} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function RegistrationDialog({ entity, onClose }: { entity: LegalEntity; onClose: () => void }) {
  const [gstin, setGstin] = useState('');
  const [registrationType, setType] = useState<'regular' | 'composition'>('regular');
  const [effectiveFrom, setFrom] = useState('');
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState<Address>(entity.address);
  const queryClient = useQueryClient();
  const regsKey = useTenantQueryKey('legal-entities', entity.id, 'registrations');
  const listKey = useTenantQueryKey('legal-entities');
  const state = gstin.length >= 2 ? gstin.slice(0, 2) : '';
  // Client-side checks for quick feedback; the server validates again.
  const localProblem = gstin.length === 15 ? (gstinProblem(gstin) ?? (gstin.slice(2, 12) !== entity.pan ? `This GSTIN contains PAN ${gstin.slice(2, 12)}, not ${entity.pan}` : undefined)) : undefined;
  const create = useMutation({
    mutationFn: () => api(`/legal-entities/${entity.id}/registrations`, { method: 'POST', body: { gstin, registrationType, effectiveFrom, label, address: { ...address, stateCode: state } }, schema: gstRegistrationSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: regsKey });
      void queryClient.invalidateQueries({ queryKey: listKey });
      onClose();
    },
  });
  const errors = fieldErrorsOf(create.error);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add GST registration" description={`For ${entity.legalName}`} className="max-w-2xl">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="flex flex-col gap-5"
      >
        {create.isError && <InlineAlert>{errorMessage(create.error)}</InlineAlert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="GSTIN" required error={localProblem ?? errors.gstin} hint={state && stateName(state) ? `State: ${stateName(state)}` : '15 characters'}>
            {(f) => <Input {...f} value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={15} className="font-mono uppercase" />}
          </FormField>
          <FormField label="Registration type" required>
            {(f) => (
              <Select {...f} value={registrationType} onChange={(e) => setType(e.target.value as 'regular' | 'composition')}>
                <option value="regular">Regular</option>
                <option value="composition">Composition</option>
              </Select>
            )}
          </FormField>
          <FormField label="Effective from" required error={errors.effectiveFrom}>
            {(f) => <Input {...f} type="date" value={effectiveFrom} onChange={(e) => setFrom(e.target.value)} />}
          </FormField>
          <FormField label="Label" hint="For example “Pune branch”" error={errors.label}>
            {(f) => <Input {...f} value={label} onChange={(e) => setLabel(e.target.value)} />}
          </FormField>
        </div>
        <AddressFields legend="Principal place of business" value={address} onChange={setAddress} errors={errorsUnder(errors, 'address')} lockState={state || undefined} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || gstin.length !== 15 || !!localProblem || !effectiveFrom}>
            {create.isPending ? 'Saving…' : 'Add registration'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type BankForm = { bankName: string; accountName: string; accountNumber: string; ifsc: string; branch: string; upiId: string; isDefault: boolean };

/**
 * Logo printed on documents numbered after it is set (FR-CO-01). PNG or JPEG
 * up to 150 KB; the server checks the file's bytes, not its name.
 */
function LogoCard({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const saved = useEntitySaved(entity.id);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (image: { contentType: string; data: string } | null) => api(`/legal-entities/${entity.id}/logo`, { method: 'PUT', body: { version: entity.version, image }, schema: legalEntitySchema }),
    onSuccess: saved,
  });
  if (!canIn('settings.company', entity.id)) return null;
  const choose = async (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') return setProblem('Choose a PNG or JPEG image.');
    if (file.size > LOGO_MAX_BYTES) return setProblem(`The logo can be at most ${Math.floor(LOGO_MAX_BYTES / 1000)} KB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    save.mutate({ contentType: file.type, data: btoa(binary) });
  };
  return (
    <Card>
      <CardHeader title="Logo" description="Printed on invoices, quotations and challans numbered after you set it. Documents already numbered keep theirs." />
      <CardBody className="flex flex-col gap-4">
        {(problem || save.isError) && <InlineAlert>{problem ?? errorMessage(save.error)}</InlineAlert>}
        <p className="text-sm">{entity.logo ? `Current logo: ${entity.logo.contentType === 'image/png' ? 'PNG' : 'JPEG'}, ${entity.logo.width} × ${entity.logo.height} pixels, ${Math.ceil(entity.logo.sizeBytes / 1000)} KB.` : 'No logo yet.'}</p>
        <FormField label={entity.logo ? 'Replace the logo' : 'Upload a logo'} hint="PNG or JPEG, up to 150 KB, between 16 and 2000 pixels on each side">
          {(f) => <Input {...f} type="file" accept="image/png,image/jpeg" disabled={save.isPending} onChange={(e) => void choose(e.target.files?.[0])} />}
        </FormField>
        {entity.logo && (
          <div>
            <Button variant="ghost" onClick={() => save.mutate(null)} disabled={save.isPending}>
              Remove the logo
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function BankAccountsCard({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const editable = canIn('settings.company', entity.id);
  const [accounts, setAccounts] = useState<BankForm[]>((entity.bankAccounts ?? []).map(({ id: _id, ...rest }) => rest));
  const saved = useEntitySaved(entity.id);
  const save = useMutation({
    mutationFn: () => api(`/legal-entities/${entity.id}/bank-accounts`, { method: 'PUT', body: { version: entity.version, bankAccounts: accounts }, schema: legalEntitySchema }),
    onSuccess: saved,
  });
  if (!entity.bankAccounts) return null;
  const errors = fieldErrorsOf(save.error);
  const update = (i: number, patch: Partial<BankForm>) => setAccounts((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : patch.isDefault ? { ...a, isDefault: false } : a)));
  return (
    <Card className="xl:col-span-2">
      <CardHeader title="Bank accounts" description="Printed on invoices for payment. Not connected to your bank." />
      <CardBody>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="flex flex-col gap-5"
        >
          {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
          {save.isSuccess && <InlineAlert tone="success">Saved.</InlineAlert>}
          {accounts.length === 0 && <p className="text-sm text-muted">No bank accounts yet.</p>}
          <fieldset disabled={!editable} className="contents">
            {accounts.map((a, i) => (
              <fieldset key={i} className="grid grid-cols-1 gap-4 rounded-md border border-border p-4 sm:grid-cols-3">
                <legend className="px-1 text-[0.8125rem] font-semibold">Account {i + 1}</legend>
                <FormField label="Bank" required error={errors[`bankAccounts.${i}.bankName`]}>
                  {(f) => <Input {...f} value={a.bankName} onChange={(e) => update(i, { bankName: e.target.value })} />}
                </FormField>
                <FormField label="Account name" required error={errors[`bankAccounts.${i}.accountName`]}>
                  {(f) => <Input {...f} value={a.accountName} onChange={(e) => update(i, { accountName: e.target.value })} />}
                </FormField>
                <FormField label="Account number" required error={errors[`bankAccounts.${i}.accountNumber`]}>
                  {(f) => <Input {...f} inputMode="numeric" value={a.accountNumber} onChange={(e) => update(i, { accountNumber: e.target.value.replace(/\s/g, '') })} className="font-mono" />}
                </FormField>
                <FormField label="IFSC" required error={errors[`bankAccounts.${i}.ifsc`]}>
                  {(f) => <Input {...f} value={a.ifsc} maxLength={11} onChange={(e) => update(i, { ifsc: e.target.value.toUpperCase() })} className="font-mono uppercase" />}
                </FormField>
                <FormField label="Branch" error={errors[`bankAccounts.${i}.branch`]}>
                  {(f) => <Input {...f} value={a.branch} onChange={(e) => update(i, { branch: e.target.value })} />}
                </FormField>
                <FormField label="UPI id" error={errors[`bankAccounts.${i}.upiId`]}>
                  {(f) => <Input {...f} value={a.upiId} onChange={(e) => update(i, { upiId: e.target.value })} />}
                </FormField>
                <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-3">
                  <Checkbox label="Default account" checked={a.isDefault} onChange={(e) => update(i, { isDefault: e.target.checked })} />
                  <Button size="sm" variant="ghost" onClick={() => setAccounts((list) => list.filter((_, j) => j !== i))}>
                    Remove account {i + 1}
                  </Button>
                </div>
              </fieldset>
            ))}
          </fieldset>
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setAccounts((list) => [...list, { bankName: '', accountName: entity.legalName, accountNumber: '', ifsc: '', branch: '', upiId: '', isDefault: list.length === 0 }])}>
                Add bank account
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save bank accounts'}
              </Button>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
