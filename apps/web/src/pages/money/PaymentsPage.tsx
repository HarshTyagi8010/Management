import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  PaymentResponse,
  PaymentMethod,
  Party,
  SalesDocument,
  SupplierBillResponse,
} from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  DataTable,
  Dialog,
  EmptyState,
  FormField,
  Input,
  Select,
  Skeleton,
  StatusBadge,
  formatBusinessDate,
  formatINR,
  type Column,
  type StatusTone,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, newIdempotencyKey } from '../../lib/api';
import { errorMessage, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function PaymentsPage({ direction }: { direction: 'incoming' | 'outgoing' }) {
  const isReceipt = direction === 'incoming';
  const title = isReceipt ? 'Customer Receipts' : 'Supplier Payments';
  usePageTitle(title);

  const { can, canIn, tenantContext } = useSession();
  const queryClient = useQueryClient();
  const entities = useLegalEntities();
  const allowed = (entities.data ?? []).filter((e) =>
    isReceipt
      ? canIn('receipt.post', e.id) || canIn('report.financial', e.id)
      : canIn('payment.post', e.id) || canIn('report.financial', e.id),
  );

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';
  const [createOpen, setCreateOpen] = useState(false);
  const [activePayment, setActivePayment] = useState<PaymentResponse | null>(null);
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState('');
  const [refundOpen, setRefundOpen] = useState(false);

  // Form states for creating payment
  const [partyId, setPartyId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  // Allocation form states
  const [allocMode, setAllocMode] = useState<'manual' | 'fifo'>('manual');
  const [manualAllocations, setManualAllocations] = useState<Record<string, string>>({});

  // Refund form states
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>('bank_transfer');

  const paymentsKey = useTenantQueryKey('payments', direction, chosenEntity);
  const paymentsQuery = useQuery({
    queryKey: paymentsKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: PaymentResponse[] }>(
        `/payments?direction=${direction}${chosenEntity ? `&legalEntityId=${chosenEntity}` : ''}`,
        { signal },
      );
      return res.data;
    },
    enabled: Boolean(chosenEntity),
  });

  // Parties for dropdown
  const partiesKey = useTenantQueryKey('parties', isReceipt ? 'customers' : 'suppliers');
  const partiesQuery = useQuery({
    queryKey: partiesKey,
    queryFn: async ({ signal }) => {
      const role = isReceipt ? 'customer' : 'supplier';
      const res = await api<{ data: Party[] }>(`/parties?role=${role}`, { signal });
      return res.data;
    },
  });

  // Obligations for manual allocation
  const obligationsKey = useTenantQueryKey('obligations', activePayment?.id ?? '');
  const obligationsQuery = useQuery({
    queryKey: obligationsKey,
    queryFn: async ({ signal }) => {
      if (!activePayment) return [];
      if (activePayment.direction === 'incoming') {
        const res = await api<{ data: SalesDocument[] }>(
          `/sales-invoices?partyId=${activePayment.partyId}&legalEntityId=${activePayment.legalEntityId}&paymentStatus=unpaid,partially_paid`,
          { signal },
        );
        return res.data;
      } else {
        const res = await api<{ data: SupplierBillResponse[] }>(
          `/supplier-bills?supplierId=${activePayment.partyId}&legalEntityId=${activePayment.legalEntityId}&paymentStatus=unpaid,partially_paid`,
          { signal },
        );
        return res.data;
      }
    },
    enabled: Boolean(activePayment && allocateOpen),
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        legalEntityId: chosenEntity,
        partyId,
        direction,
        amount,
        paymentMethod: method,
        docDate,
        reference: reference || null,
        notes,
      };
      return await api<PaymentResponse>('/payments', {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: paymentsKey });
      setCreateOpen(false);
      resetCreateForm();
    },
  });

  // Post mutation
  const postMutation = useMutation({
    mutationFn: async (id: string) => {
      return await api<PaymentResponse>(`/payments/${id}/post`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: paymentsKey });
      setActivePayment(updated);
    },
  });

  // Allocate mutation
  const allocateMutation = useMutation({
    mutationFn: async () => {
      if (!activePayment) return;
      if (allocMode === 'fifo') {
        return await api<PaymentResponse>(`/payments/${activePayment.id}/fifo-allocate`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
        });
      } else {
        const allocations = Object.entries(manualAllocations)
          .filter(([_, amt]) => parseFloat(amt || '0') > 0)
          .map(([targetId, amt]) => ({
            targetId,
            targetType: activePayment.direction === 'incoming' ? 'sales_invoice' : 'supplier_bill',
            amount: amt,
          }));
        return await api<PaymentResponse>(`/payments/${activePayment.id}/allocate`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: { allocations },
        });
      }
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: paymentsKey });
      queryClient.invalidateQueries({ queryKey: obligationsKey });
      setAllocateOpen(false);
      if (updated) setActivePayment(updated);
    },
  });

  // Reverse mutation
  const reverseMutation = useMutation({
    mutationFn: async () => {
      if (!activePayment) return;
      return await api<PaymentResponse>(`/payments/${activePayment.id}/reverse`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { reason: reverseReason },
      });
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: paymentsKey });
      setReverseOpen(false);
      setReverseReason('');
      if (updated) setActivePayment(updated);
    },
  });

  // Refund mutation
  const refundMutation = useMutation({
    mutationFn: async () => {
      if (!activePayment) return;
      const payload = {
        legalEntityId: activePayment.legalEntityId,
        partyId: activePayment.partyId,
        paymentId: activePayment.id,
        amount: refundAmount,
        refundDate: new Date().toISOString().slice(0, 10),
        paymentMethod: refundMethod,
        reason: refundReason,
      };
      return await api('/refunds', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: payload,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: paymentsKey });
      setRefundOpen(false);
      setRefundAmount('');
      setRefundReason('');
    },
  });

  const resetCreateForm = () => {
    setPartyId('');
    setAmount('');
    setMethod('bank_transfer');
    setReference('');
    setNotes('');
  };

  const getStatusTone = (status: PaymentResponse['status']): StatusTone => {
    if (status === 'posted') return 'success';
    if (status === 'draft') return 'warning';
    return 'neutral';
  };

  const columns: Column<PaymentResponse>[] = [
    {
      key: 'number',
      header: 'Number',
      primary: true,
      render: (r) => (
        <button
          type="button"
          className="text-left font-semibold text-primary hover:underline"
          onClick={() => setActivePayment(r)}
        >
          {r.number ?? 'Draft'}
        </button>
      ),
    },
    { key: 'docDate', header: 'Date', render: (r) => formatBusinessDate(r.docDate) },
    { key: 'partyName', header: isReceipt ? 'Customer' : 'Supplier', render: (r) => r.partyName },
    { key: 'method', header: 'Method', render: (r) => <span className="capitalize">{r.paymentMethod.replace('_', ' ')}</span> },
    { key: 'amount', header: 'Amount', align: 'end', render: (r) => <span className="tabular font-semibold">{formatINR(r.amount)}</span> },
    {
      key: 'unallocated',
      header: 'Unallocated',
      align: 'end',
      render: (r) => (
        <span className={parseFloat(r.unallocatedAmount) > 0 ? 'text-amber-600 font-medium tabular' : 'text-muted-foreground tabular'}>
          {formatINR(r.unallocatedAmount)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge tone={getStatusTone(r.status)} label={r.status.toUpperCase()} />,
    },
  ];

  const header = (
    <PageHeader
      title={title}
      description={
        isReceipt
          ? 'Record customer receipts, advance deposits, and allocate payments against invoices.'
          : 'Record supplier payments, disbursements, and settle outstanding bills.'
      }
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          {isReceipt ? '+ Record Receipt' : '+ Record Payment'}
        </Button>
      }
    />
  );

  if (!tenantContext || entities.isPending) return <>{header}<Skeleton className="mt-6 h-64" /></>;

  return (
    <>
      {header}

      <div className="mt-6 flex flex-wrap items-center gap-4">
        {allowed.length > 1 && (
          <div className="w-72">
            <FormField label="Legal Entity">
              {(f) => (
                <Select {...f} value={chosenEntity} onChange={(e) => setSelectedEntityId(e.target.value)}>
                  {allowed.map((e) => (
                    <option key={e.id} value={e.id}>{e.legalName}</option>
                  ))}
                </Select>
              )}
            </FormField>
          </div>
        )}
      </div>

      <Card className="mt-6">
        <CardBody className="p-0">
          {paymentsQuery.isLoading ? (
            <div className="p-6"><Skeleton className="h-48" /></div>
          ) : (paymentsQuery.data ?? []).length === 0 ? (
            <EmptyState
              title={`No ${isReceipt ? 'receipts' : 'payments'} found`}
              description={`Get started by recording a new ${isReceipt ? 'customer receipt' : 'supplier payment'}.`}
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  {isReceipt ? 'Record Receipt' : 'Record Payment'}
                </Button>
              }
            />
          ) : (
            <DataTable
              caption={title}
              hideCaption
              columns={columns}
              rows={paymentsQuery.data ?? []}
              rowKey={(r) => r.id}
            />
          )}
        </CardBody>
      </Card>

      {/* Record Payment/Receipt Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={isReceipt ? 'Record Customer Receipt' : 'Record Supplier Payment'}
      >
        <div className="space-y-4">
          <FormField label={isReceipt ? 'Customer' : 'Supplier'} required>
            {(f) => (
              <Select {...f} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                <option value="">Select party...</option>
                {(partiesQuery.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Amount (₹)" required>
              {(f) => (
                <Input
                  {...f}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Date" required>
              {(f) => (
                <Input
                  {...f}
                  type="date"
                  value={docDate}
                  onChange={(e) => setDocDate(e.target.value)}
                />
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Payment Method" required>
              {(f) => (
                <Select {...f} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                  <option value="bank_transfer">Bank Transfer (NEFT/RTGS/IMPS)</option>
                  <option value="upi">UPI</option>
                  <option value="cash">Cash</option>
                  <option value="cheque">Cheque</option>
                  <option value="card">Card</option>
                </Select>
              )}
            </FormField>

            <FormField label="Reference / UTR #">
              {(f) => (
                <Input
                  {...f}
                  placeholder="e.g. UTR12345678"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </FormField>
          </div>

          <FormField label="Notes">
            {(f) => (
              <Input
                {...f}
                placeholder="Optional notes or remittance details"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
          </FormField>

          {createMutation.isError && (
            <div className="text-sm text-danger">{errorMessage(createMutation.error)}</div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!partyId || !amount || parseFloat(amount) <= 0 || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Saving...' : 'Save as Draft'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Payment Details Dialog */}
      {activePayment && (
        <Dialog
          open={Boolean(activePayment)}
          onOpenChange={(open) => !open && setActivePayment(null)}
          title={`Payment ${activePayment.number ?? 'Draft'}`}
        >
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b pb-4">
              <div>
                <span className="text-sm text-muted">Party</span>
                <div className="font-semibold">{activePayment.partyName}</div>
              </div>
              <div className="text-right">
                <span className="text-sm text-muted">Status</span>
                <div><StatusBadge tone={getStatusTone(activePayment.status)} label={activePayment.status.toUpperCase()} /></div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 rounded-lg bg-surface-muted p-3">
              <div>
                <div className="text-xs text-muted">Total Amount</div>
                <div className="text-lg font-bold">{formatINR(activePayment.amount)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Allocated</div>
                <div className="text-lg font-bold text-success">
                  {formatINR((parseFloat(activePayment.amount) - parseFloat(activePayment.unallocatedAmount)).toFixed(2))}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Unallocated Advance</div>
                <div className="text-lg font-bold text-warning">{formatINR(activePayment.unallocatedAmount)}</div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-2 border-y py-3">
              {activePayment.status === 'draft' && (
                <Button
                  variant="primary"
                  disabled={postMutation.isPending}
                  onClick={() => postMutation.mutate(activePayment.id)}
                >
                  {postMutation.isPending ? 'Posting...' : 'Post Payment'}
                </Button>
              )}

              {activePayment.status === 'posted' && parseFloat(activePayment.unallocatedAmount) > 0 && (
                <Button variant="primary" onClick={() => setAllocateOpen(true)}>
                  Allocate Payment
                </Button>
              )}

              {activePayment.status === 'posted' && parseFloat(activePayment.unallocatedAmount) > 0 && (
                <Button variant="secondary" onClick={() => setRefundOpen(true)}>
                  Record Refund
                </Button>
              )}

              {activePayment.status === 'posted' && (
                <Button variant="danger" onClick={() => setReverseOpen(true)}>
                  Reverse Payment
                </Button>
              )}
            </div>

            {/* Existing Allocations Table */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">Active Allocations</h4>
              {activePayment.allocations.length === 0 ? (
                <div className="text-sm text-muted italic">No allocations recorded against this payment.</div>
              ) : (
                <div className="rounded border divide-y text-sm">
                  {activePayment.allocations.map((a) => (
                    <div key={a.id} className="flex items-center justify-between p-2">
                      <div>
                        <span className="font-mono">{a.targetNumber}</span>
                        <span className="ml-2 text-xs text-muted capitalize">({a.targetType.replace('_', ' ')})</span>
                      </div>
                      <div className="font-semibold tabular">{formatINR(a.amount)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Dialog>
      )}

      {/* Allocation Workspace Dialog */}
      {allocateOpen && activePayment && (
        <Dialog
          open={allocateOpen}
          onOpenChange={setAllocateOpen}
          title={`Allocate ${formatINR(activePayment.unallocatedAmount)} to Obligations`}
        >
          <div className="space-y-4">
            <div className="flex gap-4 border-b pb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="allocMode"
                  checked={allocMode === 'manual'}
                  onChange={() => setAllocMode('manual')}
                />
                <span className="text-sm font-medium">Manual Allocation</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="allocMode"
                  checked={allocMode === 'fifo'}
                  onChange={() => setAllocMode('fifo')}
                />
                <span className="text-sm font-medium">Auto FIFO Allocation</span>
              </label>
            </div>

            {allocMode === 'fifo' ? (
              <div className="rounded-lg bg-surface-muted p-4 text-sm">
                <p className="font-semibold">Deterministic First-In, First-Out Policy</p>
                <p className="mt-1 text-xs text-muted">
                  Allocates up to ₹{activePayment.unallocatedAmount} automatically to the oldest unpaid {isReceipt ? 'sales invoices' : 'supplier bills'} by document date.
                </p>
              </div>
            ) : (
              <div className="space-y-3 max-h-72 overflow-y-auto">
                {obligationsQuery.isLoading ? (
                  <Skeleton className="h-24" />
                ) : (obligationsQuery.data ?? []).length === 0 ? (
                  <div className="text-sm text-muted">No unpaid obligations found for this party.</div>
                ) : (
                  (obligationsQuery.data as any[]).map((ob) => (
                    <div key={ob.id} className="flex items-center justify-between rounded border p-2 text-sm">
                      <div>
                        <div className="font-semibold font-mono">{ob.number}</div>
                        <div className="text-xs text-muted">
                          Date: {ob.docDate} | Outstanding: ₹{ob.outstanding}
                        </div>
                      </div>
                      <div className="w-32">
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          value={manualAllocations[ob.id] ?? ''}
                          onChange={(e) =>
                            setManualAllocations((prev) => ({ ...prev, [ob.id]: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {allocateMutation.isError && (
              <div className="text-sm text-danger">{errorMessage(allocateMutation.error)}</div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="secondary" onClick={() => setAllocateOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={allocateMutation.isPending}
                onClick={() => allocateMutation.mutate()}
              >
                {allocateMutation.isPending ? 'Allocating...' : 'Apply Allocation'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Reverse Payment Confirmation Dialog */}
      {reverseOpen && (
        <Dialog
          open={reverseOpen}
          onOpenChange={setReverseOpen}
          title="Reverse Payment"
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Reversing this payment will post a mirror double-entry reversal journal, unroll any linked allocations, and restore invoice/bill outstanding balances. This action is immutable.
            </p>
            <FormField label="Reason for Reversal" required>
              {(f) => (
                <Input
                  {...f}
                  placeholder="e.g. Cheque bounced, duplicate entry"
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                />
              )}
            </FormField>
            {reverseMutation.isError && (
              <div className="text-sm text-danger">{errorMessage(reverseMutation.error)}</div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setReverseOpen(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={!reverseReason.trim() || reverseMutation.isPending}
                onClick={() => reverseMutation.mutate()}
              >
                {reverseMutation.isPending ? 'Reversing...' : 'Confirm Reversal'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Refund Dialog */}
      {refundOpen && activePayment && (
        <Dialog
          open={refundOpen}
          onOpenChange={setRefundOpen}
          title={`Record Advance Refund (Max: ${formatINR(activePayment.unallocatedAmount)})`}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Refund Amount (₹)" required>
                {(f) => (
                  <Input
                    {...f}
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Refund Method" required>
                {(f) => (
                  <Select {...f} value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as PaymentMethod)}>
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="upi">UPI</option>
                    <option value="cash">Cash</option>
                    <option value="cheque">Cheque</option>
                  </Select>
                )}
              </FormField>
            </div>

            <FormField label="Reason" required>
              {(f) => (
                <Input
                  {...f}
                  placeholder="e.g. Order cancelled, excess deposit return"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                />
              )}
            </FormField>

            {refundMutation.isError && (
              <div className="text-sm text-danger">{errorMessage(refundMutation.error)}</div>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="secondary" onClick={() => setRefundOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={
                  !refundAmount ||
                  parseFloat(refundAmount) <= 0 ||
                  parseFloat(refundAmount) > parseFloat(activePayment.unallocatedAmount) ||
                  !refundReason.trim() ||
                  refundMutation.isPending
                }
                onClick={() => refundMutation.mutate()}
              >
                {refundMutation.isPending ? 'Recording...' : 'Record Refund'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
