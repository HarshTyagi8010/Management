import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { legalEntitySchema, type LegalEntity, type WorkflowSettings } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, Checkbox, InlineAlert } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { useEntityChoice } from './EntityPicker';

export function WorkflowPage() {
  usePageTitle('Workflow');
  const { entity, picker, state } = useEntityChoice();
  return (
    <>
      <PageHeader title="Workflow" description="When stock moves and how totals are rounded, per business entity." />
      {state}
      {picker}
      {entity && <WorkflowForm key={`${entity.id}:${entity.version}`} entity={entity} />}
    </>
  );
}

function Choice({ name, value, current, onChange, label, description, disabled }: { name: string; value: string; current: string; onChange: (v: string) => void; label: string; description: string; disabled: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 has-checked:border-accent has-checked:bg-accent-soft">
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => onChange(value)} disabled={disabled} className="mt-1 accent-accent" />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted">{description}</span>
      </span>
    </label>
  );
}

function WorkflowForm({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const editable = canIn('settings.workflow', entity.id);
  const [form, setForm] = useState<WorkflowSettings>(entity.workflow);
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('legal-entities');
  const save = useMutation({
    mutationFn: () => api(`/legal-entities/${entity.id}/workflow`, { method: 'PUT', body: { ...form, version: entity.version }, schema: legalEntitySchema }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  return (
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
      <Card>
        <CardHeader title="Stock goes out on" description="Stock moves exactly once: at this step and no other." />
        <CardBody>
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Stock goes out on</legend>
            <Choice name="out" value="dispatch" current={form.stockOutPoint} onChange={(v) => setForm({ ...form, stockOutPoint: v as WorkflowSettings['stockOutPoint'] })} label="Dispatch (delivery challan)" description="Goods leave when dispatched; the invoice follows." disabled={!editable} />
            <Choice name="out" value="invoice" current={form.stockOutPoint} onChange={(v) => setForm({ ...form, stockOutPoint: v as WorkflowSettings['stockOutPoint'] })} label="Invoice" description="Goods leave when the invoice is issued (counter sales)." disabled={!editable} />
          </fieldset>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Stock comes in on" />
        <CardBody>
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Stock comes in on</legend>
            <Choice name="in" value="goods_receipt" current={form.stockInPoint} onChange={(v) => setForm({ ...form, stockInPoint: v as WorkflowSettings['stockInPoint'] })} label="Goods receipt" description="Stock arrives when goods are received; the supplier bill follows." disabled={!editable} />
            <Choice name="in" value="supplier_bill" current={form.stockInPoint} onChange={(v) => setForm({ ...form, stockInPoint: v as WorkflowSettings['stockInPoint'] })} label="Supplier bill" description="Stock arrives when the supplier bill is posted." disabled={!editable} />
          </fieldset>
        </CardBody>
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader title="Other rules" />
        <CardBody className="flex flex-col gap-3">
          <Checkbox label="Allow negative stock" description="Off is safer: you can't sell what the system says you don't have." checked={form.allowNegativeStock} onChange={(e) => setForm({ ...form, allowNegativeStock: e.target.checked })} disabled={!editable} />
          <Checkbox label="Round document totals to the nearest rupee" description="Adds a round-off line of up to ±₹0.50." checked={form.roundOffTotal} onChange={(e) => setForm({ ...form, roundOffTotal: e.target.checked })} disabled={!editable} />
          <p className="text-xs text-muted">Changing these will be blocked while open documents depend on them, once documents arrive.</p>
          {editable && (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save workflow'}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </form>
  );
}
