import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { gstinProblem, partySchema, stateName, type Address, type Party } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, Checkbox, ErrorState, FormField, InlineAlert, Input, Select, Skeleton } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { AddressFields, EMPTY_ADDRESS, errorsUnder, PageHeader } from '../../components/forms';
import { api, ApiError } from '../../lib/api';
import { errorMessage, fieldErrorsOf, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { PartyTimeline } from './Crm';

type AddressRow = Address & { id: string; label: string; isBilling: boolean; isShipping: boolean };
type ContactRow = { id: string; name: string; designation: string; phone: string; email: string };
type Form = {
  name: string;
  legalName: string;
  isCustomer: boolean;
  isSupplier: boolean;
  pan: string;
  gstins: Array<{ gstin: string; addressId: string | null }>;
  addresses: AddressRow[];
  contacts: ContactRow[];
  creditLimit: string;
  paymentTermsDays: string;
};

let seq = 0;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;

const blank = (role: string | null): Form => ({
  name: '',
  legalName: '',
  isCustomer: role !== 'supplier',
  isSupplier: role === 'supplier',
  pan: '',
  gstins: [],
  addresses: [{ ...EMPTY_ADDRESS, id: 'a1', label: 'Main', isBilling: true, isShipping: true }],
  contacts: [],
  creditLimit: '',
  paymentTermsDays: '',
});

const fromParty = (p: Party): Form => ({
  name: p.name,
  legalName: p.legalName,
  isCustomer: p.isCustomer,
  isSupplier: p.isSupplier,
  pan: p.pan ?? '',
  gstins: (p.gstins ?? []).map((g) => ({ gstin: g.gstin, addressId: g.addressId })),
  addresses: p.addresses,
  contacts: p.contacts ?? [],
  creditLimit: p.creditLimit ?? '',
  paymentTermsDays: p.paymentTermsDays === null || p.paymentTermsDays === undefined ? '' : String(p.paymentTermsDays),
});

const tabTrigger = 'inline-flex h-10 cursor-pointer items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted data-[state=active]:border-accent data-[state=active]:text-text';

export function PartyFormPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const key = useTenantQueryKey('parties', 'detail', id ?? 'new');
  const party = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/parties/${id}`, { schema: partySchema, signal }), enabled: !isNew });
  const { can } = useSession();
  usePageTitle(isNew ? 'Add party' : (party.data?.name ?? 'Party'));
  if (!isNew && party.isPending) return <Skeleton className="h-64" />;
  if (!isNew && party.isError) return <Card><ErrorState title="Not available" message={errorMessage(party.error)} /></Card>;
  const p = party.data;
  if (isNew || !p) return <PartyForm party={null} />;
  return (
    <>
      <p className="text-sm">
        <Link to={p.isCustomer ? '/parties/customers' : '/parties/suppliers'} className="text-accent underline-offset-2 hover:underline">
          {p.isCustomer ? 'Customers' : 'Suppliers'}
        </Link>
      </p>
      <PageHeader title={p.name} description={[p.isCustomer && 'Customer', p.isSupplier && 'Supplier', p.archived && 'Archived'].filter(Boolean).join(' · ')} />
      <Tabs.Root defaultValue="details" className="mt-6">
        <Tabs.List aria-label="Party" className="flex gap-1 overflow-x-auto border-b border-border">
          <Tabs.Trigger value="details" className={tabTrigger}>
            Details
          </Tabs.Trigger>
          {can('party.view') && (
            <Tabs.Trigger value="crm" className={tabTrigger}>
              Notes &amp; follow-ups
            </Tabs.Trigger>
          )}
        </Tabs.List>
        <Tabs.Content value="details" className="mt-4 focus:outline-none">
          <PartyForm key={p.version} party={p} />
        </Tabs.Content>
        {can('party.view') && (
          <Tabs.Content value="crm" className="mt-4 focus:outline-none">
            <PartyTimeline party={p} />
          </Tabs.Content>
        )}
      </Tabs.Root>
    </>
  );
}

function PartyForm({ party }: { party: Party | null }) {
  const { can } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(party ? fromParty(party) : blank(params.get('role')));
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const editable = can('party.edit');

  const save = useMutation({
    mutationFn: (confirmDuplicates: boolean) => {
      const body = {
        name: form.name,
        legalName: form.legalName,
        isCustomer: form.isCustomer,
        isSupplier: form.isSupplier,
        pan: form.pan,
        gstins: form.gstins.filter((g) => g.gstin),
        addresses: form.addresses,
        contacts: form.contacts,
        creditLimit: form.creditLimit.trim() || null,
        paymentTermsDays: form.paymentTermsDays === '' ? null : Number(form.paymentTermsDays),
        confirmDuplicates,
      };
      return party ? api(`/parties/${party.id}`, { method: 'PATCH', body: { ...body, version: party.version }, schema: partySchema }) : api('/parties', { method: 'POST', body, schema: partySchema });
    },
    onMutate: () => setDuplicates([]),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['tenant'] });
      if (!party) navigate(`/parties/${saved.id}`, { replace: true });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'DUPLICATE') setDuplicates(err.details.map((d) => d.message));
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api(`/parties/${party?.id}`, { method: 'PATCH', body: { version: party?.version, archived }, schema: partySchema }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tenant'] }),
  });
  const errors = fieldErrorsOf(save.error);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const updateAddress = (i: number, patch: Partial<AddressRow>) => setForm({ ...form, addresses: form.addresses.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const updateContact = (i: number, patch: Partial<ContactRow>) => setForm({ ...form, contacts: form.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const updateGstin = (i: number, patch: Partial<Form['gstins'][number]>) => {
    const gstins = form.gstins.map((g, j) => (j === i ? { ...g, ...patch } : g));
    // A valid GSTIN fills in the PAN when it is still empty (characters 3-12 are the PAN).
    const valid = patch.gstin && patch.gstin.length === 15 && !gstinProblem(patch.gstin);
    setForm({ ...form, gstins, pan: !form.pan && valid && patch.gstin ? patch.gstin.slice(2, 12) : form.pan });
  };

  return (
    <>
      {!party && <PageHeader title={form.isSupplier && !form.isCustomer ? 'Add supplier' : 'Add customer'} />}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(false);
        }}
        className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2"
      >
        {duplicates.length > 0 ? (
          <InlineAlert tone="warning" className="xl:col-span-2">
            <p className="font-medium">This may already exist:</p>
            <ul className="mt-1 list-disc pl-5">
              {duplicates.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => save.mutate(true)}>
              It’s different, save anyway
            </Button>
          </InlineAlert>
        ) : (
          save.isError && <InlineAlert className="xl:col-span-2">{errorMessage(save.error)}</InlineAlert>
        )}
        {save.isSuccess && party && <InlineAlert tone="success" className="xl:col-span-2">Saved.</InlineAlert>}
        <fieldset disabled={!editable} className="contents">
          <Card>
            <CardHeader title="Identity" />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Name" required error={errors.name} className="sm:col-span-2">
                {(f) => <Input {...f} value={form.name} onChange={set('name')} />}
              </FormField>
              <FormField label="Legal name" error={errors.legalName} className="sm:col-span-2" hint="If different, as on the GST certificate">
                {(f) => <Input {...f} value={form.legalName} onChange={set('legalName')} />}
              </FormField>
              <FormField label="PAN" error={errors.pan}>
                {(f) => <Input {...f} value={form.pan} maxLength={10} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} className="font-mono uppercase" />}
              </FormField>
              <div className="flex flex-col gap-2 pt-6">
                <Checkbox label="Customer" checked={form.isCustomer} onChange={(e) => setForm({ ...form, isCustomer: e.target.checked })} />
                <Checkbox label="Supplier" checked={form.isSupplier} onChange={(e) => setForm({ ...form, isSupplier: e.target.checked })} />
                {errors.isCustomer && <p className="text-xs font-medium text-danger">{errors.isCustomer}</p>}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="GSTINs" description="Leave empty for unregistered parties." />
            <CardBody className="flex flex-col gap-4">
              {form.gstins.map((g, i) => {
                const local = g.gstin.length === 15 ? (gstinProblem(g.gstin) ?? (form.pan && g.gstin.slice(2, 12) !== form.pan ? 'This GSTIN contains a different PAN' : undefined)) : undefined;
                return (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <FormField label={`GSTIN ${i + 1}`} error={local ?? errors[`gstins.${i}.gstin`]} hint={g.gstin.length >= 2 ? stateName(g.gstin.slice(0, 2)) : undefined} className="min-w-52 flex-1">
                      {(f) => <Input {...f} value={g.gstin} maxLength={15} onChange={(e) => updateGstin(i, { gstin: e.target.value.toUpperCase().replace(/\s/g, '') })} className="font-mono uppercase" />}
                    </FormField>
                    <FormField label="Address" className="w-40">
                      {(f) => (
                        <Select {...f} value={g.addressId ?? ''} onChange={(e) => updateGstin(i, { addressId: e.target.value || null })}>
                          <option value="">—</option>
                          {form.addresses.map((a, j) => (
                            <option key={a.id} value={a.id}>
                              {a.label || `Address ${j + 1}`}
                            </option>
                          ))}
                        </Select>
                      )}
                    </FormField>
                    <Button variant="ghost" onClick={() => setForm({ ...form, gstins: form.gstins.filter((_, j) => j !== i) })}>
                      Remove
                    </Button>
                  </div>
                );
              })}
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setForm({ ...form, gstins: [...form.gstins, { gstin: '', addressId: form.addresses[0]?.id ?? null }] })}
                >
                  Add GSTIN
                </Button>
              </div>
            </CardBody>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader title="Addresses" />
            <CardBody className="flex flex-col gap-6">
              {form.addresses.map((a, i) => (
                <div key={a.id} className="flex flex-col gap-3 rounded-md border border-border p-4">
                  <div className="flex flex-wrap items-end gap-4">
                    <FormField label="Label" className="w-48">
                      {(f) => <Input {...f} value={a.label} onChange={(e) => updateAddress(i, { label: e.target.value })} />}
                    </FormField>
                    <Checkbox label="Billing" checked={a.isBilling} onChange={(e) => updateAddress(i, { isBilling: e.target.checked })} />
                    <Checkbox label="Shipping" checked={a.isShipping} onChange={(e) => updateAddress(i, { isShipping: e.target.checked })} />
                    {form.addresses.length > 1 && (
                      <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, addresses: form.addresses.filter((_, j) => j !== i), gstins: form.gstins.map((g) => (g.addressId === a.id ? { ...g, addressId: null } : g)) })}>
                        Remove address
                      </Button>
                    )}
                  </div>
                  <AddressFields legend={a.label || `Address ${i + 1}`} value={a} onChange={(next) => updateAddress(i, next)} errors={errorsUnder(errors, `addresses.${i}`)} />
                </div>
              ))}
              <div>
                <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, addresses: [...form.addresses, { ...EMPTY_ADDRESS, id: newId('a'), label: '', isBilling: false, isShipping: true }] })}>
                  Add address
                </Button>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Contacts" />
            <CardBody className="flex flex-col gap-4">
              {form.contacts.length === 0 && <p className="text-sm text-muted">No contacts yet.</p>}
              {form.contacts.map((c, i) => (
                <fieldset key={c.id} className="grid grid-cols-1 gap-3 rounded-md border border-border p-4 sm:grid-cols-2">
                  <legend className="px-1 text-[0.8125rem] font-semibold">Contact {i + 1}</legend>
                  <FormField label="Name" required error={errors[`contacts.${i}.name`]}>
                    {(f) => <Input {...f} value={c.name} onChange={(e) => updateContact(i, { name: e.target.value })} />}
                  </FormField>
                  <FormField label="Designation">
                    {(f) => <Input {...f} value={c.designation} onChange={(e) => updateContact(i, { designation: e.target.value })} />}
                  </FormField>
                  <FormField label="Phone" error={errors[`contacts.${i}.phone`]}>
                    {(f) => <Input {...f} type="tel" value={c.phone} onChange={(e) => updateContact(i, { phone: e.target.value })} />}
                  </FormField>
                  <FormField label="Email" error={errors[`contacts.${i}.email`]}>
                    {(f) => <Input {...f} type="email" value={c.email} onChange={(e) => updateContact(i, { email: e.target.value })} />}
                  </FormField>
                  <div className="sm:col-span-2">
                    <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, contacts: form.contacts.filter((_, j) => j !== i) })}>
                      Remove contact {i + 1}
                    </Button>
                  </div>
                </fieldset>
              ))}
              <div>
                <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, contacts: [...form.contacts, { id: newId('c'), name: '', designation: '', phone: '', email: '' }] })}>
                  Add contact
                </Button>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Terms" />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Credit limit (₹)" error={errors.creditLimit} hint="Leave empty for no limit">
                {(f) => <Input {...f} inputMode="decimal" value={form.creditLimit} onChange={set('creditLimit')} />}
              </FormField>
              <FormField label="Payment terms (days)" error={errors.paymentTermsDays}>
                {(f) => <Input {...f} type="number" min={0} max={365} value={form.paymentTermsDays} onChange={set('paymentTermsDays')} />}
              </FormField>
            </CardBody>
          </Card>
        </fieldset>
        {editable && (
          <div className="flex flex-wrap gap-2 xl:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : party ? 'Save' : 'Add'}
            </Button>
            {party && (
              <Button variant="secondary" onClick={() => archive.mutate(!party.archived)} disabled={archive.isPending}>
                {party.archived ? 'Restore' : 'Archive'}
              </Button>
            )}
          </div>
        )}
        {archive.isError && <InlineAlert className="xl:col-span-2">{errorMessage(archive.error)}</InlineAlert>}
      </form>
    </>
  );
}
