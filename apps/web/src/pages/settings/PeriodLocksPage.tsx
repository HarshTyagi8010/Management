import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { legalEntitySchema, type LegalEntity } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, FormField, InlineAlert, Input, formatBusinessDate } from '@bizmgmt/ui';
import { useStepUp } from '../../auth/StepUp';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { useEntityChoice } from './EntityPicker';

export function PeriodLocksPage() {
  usePageTitle('Period locks');
  const { entity, picker, state } = useEntityChoice();
  return (
    <>
      <PageHeader title="Period locks" description="Close a period so that nothing dated in it can be posted or changed, for example after filing returns." />
      {state}
      {picker}
      {entity && <PeriodLockForm key={`${entity.id}:${entity.version}`} entity={entity} />}
    </>
  );
}

/** Today in IST as YYYY-MM-DD; a lock must be before today. */
const todayIST = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

function PeriodLockForm({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('legal-entities');
  const canLock = canIn('period.lock', entity.id);
  const canUnlock = canIn('period.unlock', entity.id);
  const [lockDate, setLockDate] = useState(entity.periodLockDate ?? '');
  const [reason, setReason] = useState('');
  const next = lockDate || null;
  const backward = entity.periodLockDate !== null && (next === null || next < entity.periodLockDate);
  const save = useMutation({
    // Moving a lock back needs a fresh two-step code; the server checks it and the dialog asks for it.
    mutationFn: () => {
      const call = () => api(`/legal-entities/${entity.id}/period-lock`, { method: 'PUT', body: { version: entity.version, lockDate: next, reason }, schema: legalEntitySchema });
      return backward ? stepUp(call) : call();
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const errors = fieldErrorsOf(save.error);
  const allowed = backward ? canUnlock : canLock;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Card className="mt-6">
      <CardHeader
        title={entity.periodLockDate ? `Locked up to ${formatBusinessDate(entity.periodLockDate)}` : 'No period is locked'}
        description={entity.periodLockDate ? 'Stock movements and, from Phase 7, documents dated on or before this date are refused.' : 'Anything can still be posted with any past date.'}
      />
      <CardBody>
        {!canLock && !canUnlock ? (
          <p className="text-sm text-muted">Locking periods needs the “Lock accounting periods” permission.</p>
        ) : (
          <form noValidate onSubmit={submit} className="flex max-w-xl flex-col gap-4">
            {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
            {save.isSuccess && <InlineAlert tone="success">Saved.</InlineAlert>}
            <FormField label="Lock postings up to and including" error={errors.lockDate} hint="Leave empty to remove the lock.">
              {(f) => <Input {...f} type="date" max={todayIST()} value={lockDate} onChange={(e) => setLockDate(e.target.value)} />}
            </FormField>
            <FormField label="Reason" required error={errors.reason} hint="Kept in the audit log.">
              {(f) => <Input {...f} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
            </FormField>
            {backward && <InlineAlert tone="warning">This reopens a closed period. It needs the “Unlock accounting periods” permission and a two-step code.</InlineAlert>}
            <div>
              <Button type="submit" disabled={save.isPending || !allowed || next === entity.periodLockDate || reason.trim().length < 5}>
                {save.isPending ? 'Saving…' : backward ? 'Reopen period' : 'Lock period'}
              </Button>
            </div>
            {!allowed && <p className="text-xs text-muted">You can move the lock forward but not back.</p>}
          </form>
        )}
      </CardBody>
    </Card>
  );
}
