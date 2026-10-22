import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  legalEntitySchema,
  type ChecklistFinding,
  type LegalEntity,
  type PeriodCloseChecklistResponse,
  type PeriodCloseExecuteResponse,
} from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PermissionDenied,
  Select,
  Skeleton,
  StatusBadge,
  formatBusinessDate,
} from '@bizmgmt/ui';
import { useStepUp } from '../../auth/StepUp';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { useEntityChoice } from './EntityPicker';

/** Today in IST as YYYY-MM-DD; a lock must be before today. */
const todayIST = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function PeriodLocksPage() {
  usePageTitle('Period-Close Readiness & Posting Locks');
  const { entity, picker, state } = useEntityChoice();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Period-Close Readiness & Posting Locks"
        description="Authoritative period close evaluation, reconciliation readiness checklist, and administrative posting lock coordination."
      />

      {state}
      {picker}

      {entity && (
        <>
          <PeriodCloseCoordinator key={`coord:${entity.id}:${entity.version}`} entity={entity} />
          <LegacyPeriodLockForm key={`lock:${entity.id}:${entity.version}`} entity={entity} />
        </>
      )}
    </div>
  );
}

function PeriodCloseCoordinator({ entity }: { entity: LegalEntity }) {
  const { canIn } = useSession();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const entityKey = useTenantQueryKey('legal-entities');

  const canLock = canIn('period.lock', entity.id);
  const canUnlock = canIn('period.unlock', entity.id);

  // Target cutoff date (defaults to end of last month)
  const [periodEndDate, setPeriodEndDate] = useState(() => {
    const d = new Date();
    d.setDate(0); // Last day of prior month
    return d.toISOString().slice(0, 10);
  });

  const [mode, setMode] = useState<'reconciled_close' | 'administrative_lock'>('reconciled_close');
  const [reason, setReason] = useState('');
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [lastClosedResult, setLastClosedResult] = useState<PeriodCloseExecuteResponse | null>(null);
  const [staleErrorNotice, setStaleErrorNotice] = useState<string | null>(null);

  // Live Readiness Checklist Query
  const checklistKey = useTenantQueryKey('compliance', 'period-close', 'checklist', entity.id, periodEndDate, mode);
  const checklistQuery = useQuery({
    queryKey: checklistKey,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        legalEntityId: entity.id,
        periodEndDate,
        mode,
      });
      return api<PeriodCloseChecklistResponse>(`/compliance/period-close/checklist?${params.toString()}`, { signal });
    },
    enabled: Boolean(entity.id && periodEndDate && periodEndDate < todayIST()),
  });

  const checklist = checklistQuery.data;

  // Execute Close Mutation
  const executeClose = useMutation({
    mutationFn: async () => {
      if (!checklist) throw new Error('Checklist not loaded');
      setStaleErrorNotice(null);

      return api<PeriodCloseExecuteResponse>('/compliance/period-close/execute', {
        method: 'POST',
        body: {
          legalEntityId: entity.id,
          periodEndDate,
          coordinationToken: checklist.coordinationToken,
          mode,
          reason,
          acknowledgeWarnings,
        },
      });
    },
    onSuccess: (data) => {
      setLastClosedResult(data);
      setReason('');
      setAcknowledgeWarnings(false);
      void queryClient.invalidateQueries({ queryKey: entityKey });
      void checklistQuery.refetch();
    },
    onError: (err: any) => {
      const msg = errorMessage(err);
      if (msg.includes('financial postings') || msg.includes('stale') || msg.includes('changed')) {
        setStaleErrorNotice(
          'Checklist is stale: Underlying financial postings or ledger findings changed after the checklist was generated. The checklist has been automatically refreshed. Please review updated findings and re-confirm.',
        );
        setAcknowledgeWarnings(false);
        void checklistQuery.refetch();
      }
    },
  });

  // Backward unlock mutation (Reopen period)
  const [unlockReason, setUnlockReason] = useState('');
  const [unlockTargetDate, setUnlockTargetDate] = useState<string>('');
  const executeUnlock = useMutation({
    mutationFn: () => {
      const call = () =>
        api(`/legal-entities/${entity.id}/period-lock`, {
          method: 'PUT',
          body: {
            version: entity.version,
            lockDate: unlockTargetDate || null,
            reason: unlockReason,
          },
        });
      return stepUp(call);
    },
    onSuccess: () => {
      setUnlockReason('');
      setUnlockTargetDate('');
      void queryClient.invalidateQueries({ queryKey: entityKey });
      void checklistQuery.refetch();
    },
  });

  if (!canLock && !canUnlock) {
    return (
      <Card className="mt-6">
        <CardBody>
          <PermissionDenied permission="period.lock" />
        </CardBody>
      </Card>
    );
  }

  const blockersCount = checklist?.counts.blockers ?? 0;
  const warningsCount = checklist?.counts.warnings ?? 0;
  const canSubmitClose =
    Boolean(checklist) &&
    checklist?.canClose &&
    blockersCount === 0 &&
    (warningsCount === 0 || acknowledgeWarnings) &&
    reason.trim().length >= 5 &&
    !executeClose.isPending;

  return (
    <div className="space-y-6">
      {/* Current Lock State Card */}
      <Card>
        <CardHeader
          title={
            entity.periodLockDate
              ? `Current Authoritative Lock: ${formatBusinessDate(entity.periodLockDate)}`
              : 'No Active Period Lock'
          }
          description={
            entity.periodLockDate
              ? 'General ledger postings and inventory movements on or before this cutoff date are strictly blocked by transactional database guards.'
              : 'Transactions can currently be backdated into any prior period without lock restriction.'
          }
        />
        <CardBody className="text-xs text-muted">
          <p>
            Entity PAN: <strong>{entity.pan}</strong> · Entity ID:{' '}
            <strong className="font-mono">{entity.id}</strong>
          </p>
        </CardBody>
      </Card>

      {/* Confirmation of Last Action */}
      {lastClosedResult && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
          <p className="font-bold text-sm">Period Action Confirmed</p>
          <p className="mt-1 text-xs">
            {lastClosedResult.message} (Closed at {new Date(lastClosedResult.closedAt).toLocaleTimeString()}).
          </p>
          {lastClosedResult.closeMode === 'administrative_lock' && (
            <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
              Note: This action is an administrative posting lock only. It does not certify historical reconciliation or GST filing.
            </p>
          )}
        </div>
      )}

      {/* Stale Checklist Alert */}
      {staleErrorNotice && (
        <InlineAlert tone="warning">
          {staleErrorNotice}
        </InlineAlert>
      )}

      {/* Close Coordinator Configuration */}
      <Card>
        <CardHeader
          title="Period-Close Readiness Evaluation"
          description="Select target period end date and closing mode to generate an authoritative cryptographic readiness checklist."
        />
        <CardBody className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Target Period Cutoff Date" hint="Must be a date in the past">
              {(f) => (
                <Input
                  {...f}
                  type="date"
                  max={todayIST()}
                  value={periodEndDate}
                  onChange={(e) => {
                    setPeriodEndDate(e.target.value);
                    setAcknowledgeWarnings(false);
                  }}
                  disabled={executeClose.isPending}
                />
              )}
            </FormField>

            <FormField label="Closing Mode" hint="Reconciled vs Administrative Lock">
              {(f) => (
                <Select
                  {...f}
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as 'reconciled_close' | 'administrative_lock');
                    setAcknowledgeWarnings(false);
                  }}
                  disabled={executeClose.isPending}
                >
                  <option value="reconciled_close">Reconciled Close (Subledger Verified)</option>
                  <option value="administrative_lock">Administrative Posting Lock (Historical)</option>
                </Select>
              )}
            </FormField>

            <div className="flex items-end">
              <Button
                variant="secondary"
                onClick={() => void checklistQuery.refetch()}
                disabled={checklistQuery.isFetching || executeClose.isPending}
              >
                {checklistQuery.isFetching ? 'Evaluating…' : 'Re-evaluate Checklist'}
              </Button>
            </div>
          </div>

          {/* Checklist Findings Summary */}
          {checklistQuery.isPending && (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}

          {checklistQuery.isError && (
            <ErrorState
              message={errorMessage(checklistQuery.error)}
              onRetry={() => void checklistQuery.refetch()}
            />
          )}

          {checklist && (
            <div className="space-y-6">
              {/* KPIs */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
                  <div className="text-xs font-medium text-muted">Ready to Close</div>
                  <div className="mt-1 text-lg font-semibold tabular text-text">{checklist.canClose ? 'ELIGIBLE' : 'BLOCKED'}</div>
                  <div className="mt-1 text-xs text-muted">{checklist.canClose ? 'All blocker checks passed' : 'Active blockers detected'}</div>
                </div>
                <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
                  <div className="text-xs font-medium text-muted">Blockers (Must Resolve)</div>
                  <div className="mt-1 text-lg font-semibold tabular text-text">{checklist.counts.blockers}</div>
                  <div className="mt-1 text-xs text-muted">Strictly prevents period close</div>
                </div>
                <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
                  <div className="text-xs font-medium text-muted">Warnings (Requires Ack)</div>
                  <div className="mt-1 text-lg font-semibold tabular text-text">{checklist.counts.warnings}</div>
                  <div className="mt-1 text-xs text-muted">Draft docs / admin lock</div>
                </div>
                <div className="rounded-lg border border-border bg-surface p-4 shadow-card">
                  <div className="text-xs font-medium text-muted">Reconciliation Status</div>
                  <div className="mt-1 text-lg font-semibold tabular text-text">{checklist.reconciliationStatus}</div>
                  <div className="mt-1 text-xs text-muted">{checklist.isPastPeriod ? 'Subsequent postings exist' : 'Live state evaluated'}</div>
                </div>
              </div>

              {/* Notice for Past Periods / Unsupported Historical */}
              {checklist.pastPeriodNotice && (
                <div className="rounded-md border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
                  <p className="font-semibold">Period State Disclosure:</p>
                  <p className="mt-0.5">{checklist.pastPeriodNotice}</p>
                </div>
              )}

              {/* Findings List */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-muted">
                  Evaluated Findings ({checklist.findings.length})
                </h4>

                <div className="divide-y divide-border rounded-md border">
                  {checklist.findings.map((f: ChecklistFinding, idx: number) => (
                    <div key={idx} className="p-3 text-xs flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <StatusBadge
                            label={f.severity.toUpperCase()}
                            tone={
                              f.severity === 'blocker'
                                ? 'danger'
                                : f.severity === 'warning'
                                ? 'warning'
                                : 'success'
                            }
                          />
                          <span className="font-bold">{f.title}</span>
                          <span className="font-mono text-[10px] text-muted">({f.code})</span>
                        </div>
                        <p className="mt-1 text-muted">{f.description}</p>
                      </div>

                      <div className="text-right">
                        <span className="capitalize text-[10px] text-muted">{f.category}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Execution Form */}
              <form
                noValidate
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  executeClose.mutate();
                }}
                className="rounded-md border bg-muted/5 p-4 space-y-4"
              >
                <h4 className="text-sm font-semibold">Confirm Period Close</h4>

                {executeClose.isError && (
                  <InlineAlert tone="danger">
                    {errorMessage(executeClose.error)}
                  </InlineAlert>
                )}

                {warningsCount > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50/50 p-3">
                    <label className="flex items-center gap-2 text-xs font-semibold text-amber-950 dark:text-amber-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={acknowledgeWarnings}
                        onChange={(e) => setAcknowledgeWarnings(e.target.checked)}
                        disabled={executeClose.isPending}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      I acknowledge the {warningsCount} warning(s) listed above and confirm proceeding with close.
                    </label>
                  </div>
                )}

                <FormField
                  label="Mandatory Close Reason"
                  required
                  hint="Recorded immutably in the audit log (minimum 5 characters)."
                >
                  {(f) => (
                    <Input
                      {...f}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. October 2026 books closed following tax filing review"
                      maxLength={300}
                      disabled={executeClose.isPending}
                    />
                  )}
                </FormField>

                <div>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!canSubmitClose}
                  >
                    {executeClose.isPending
                      ? 'Closing Period…'
                      : mode === 'administrative_lock'
                      ? `Apply Administrative Lock up to ${formatBusinessDate(periodEndDate)}`
                      : `Execute Reconciled Close up to ${formatBusinessDate(periodEndDate)}`}
                  </Button>

                  {blockersCount > 0 && (
                    <p className="mt-2 text-xs text-rose-600">
                      Cannot close period: {blockersCount} blocker(s) must be resolved first.
                    </p>
                  )}
                </div>
              </form>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Backward Unlock (Reopen) Section */}
      {entity.periodLockDate && canUnlock && (
        <Card className="border-amber-300">
          <CardHeader
            title="Reopen Closed Period (Move Lock Backward)"
            description="Reopening closed books requires step-up two-factor reauthentication and creates a high-priority audit record."
          />
          <CardBody className="space-y-4">
            {executeUnlock.isError && (
              <InlineAlert tone="danger">{errorMessage(executeUnlock.error)}</InlineAlert>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="New Earlier Cutoff Date"
                hint="Leave empty to completely remove lock."
              >
                {(f) => (
                  <Input
                    {...f}
                    type="date"
                    max={entity.periodLockDate ?? undefined}
                    value={unlockTargetDate}
                    onChange={(e) => setUnlockTargetDate(e.target.value)}
                    disabled={executeUnlock.isPending}
                  />
                )}
              </FormField>

              <FormField label="Reason for Reopening" required hint="Required for audit logging.">
                {(f) => (
                  <Input
                    {...f}
                    value={unlockReason}
                    onChange={(e) => setUnlockReason(e.target.value)}
                    placeholder="e.g. Auditor adjustments required for Q2 return"
                    disabled={executeUnlock.isPending}
                  />
                )}
              </FormField>
            </div>

            <Button
              variant="secondary"
              onClick={() => executeUnlock.mutate()}
              disabled={executeUnlock.isPending || unlockReason.trim().length < 5}
            >
              {executeUnlock.isPending ? 'Verifying 2FA…' : 'Reopen Period (Step-Up 2FA)'}
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function LegacyPeriodLockForm({ entity }: { entity: LegalEntity }) {
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
        description={entity.periodLockDate ? 'Stock movements and documents dated on or before this date are refused.' : 'Anything can still be posted with any past date.'}
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
