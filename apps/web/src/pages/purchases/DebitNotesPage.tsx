import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  DebitNoteResponse,
  Party,
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

export function DebitNotesPage() {
  usePageTitle('Debit Notes & Purchase Returns');
  const { can, canIn, tenantContext } = useSession();
  const queryClient = useQueryClient();
  const entities = useLegalEntities();
  const allowed = (entities.data ?? []).filter((e) =>
    canIn('note.issue', e.id) || canIn('report.financial', e.id),
  );

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';
  const [createOpen, setCreateOpen] = useState(false);
  const [activeNote, setActiveNote] = useState<DebitNoteResponse | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  // Form states
  const [supplierId, setSupplierId] = useState('');
  const [billId, setBillId] = useState('');
  const [kind, setKind] = useState<'purchase_return' | 'price_adjustment'>('purchase_return');
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [lineQty, setLineQty] = useState('1');
  const [linePrice, setLinePrice] = useState('');
  const [lineTaxRate, setLineTaxRate] = useState('18');
  const [notes, setNotes] = useState('');

  const notesKey = useTenantQueryKey('debit-notes', chosenEntity);
  const notesQuery = useQuery({
    queryKey: notesKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: DebitNoteResponse[] }>(
        `/debit-notes${chosenEntity ? `?legalEntityId=${chosenEntity}` : ''}`,
        { signal },
      );
      return res.data;
    },
    enabled: Boolean(chosenEntity),
  });

  // Fetch suppliers
  const suppliersKey = useTenantQueryKey('parties', 'suppliers');
  const suppliersQuery = useQuery({
    queryKey: suppliersKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: Party[] }>('/parties?role=supplier', { signal });
      return res.data;
    },
  });

  // Fetch supplier bills
  const billsKey = useTenantQueryKey('supplier-bills-lookup', supplierId, chosenEntity);
  const billsQuery = useQuery({
    queryKey: billsKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: SupplierBillResponse[] }>(
        `/supplier-bills?supplierId=${supplierId}&legalEntityId=${chosenEntity}&status=posted`,
        { signal },
      );
      return res.data;
    },
    enabled: Boolean(supplierId && chosenEntity && createOpen),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        legalEntityId: chosenEntity,
        partyId: supplierId,
        supplierBillId: billId,
        kind,
        docDate,
        reason,
        lines: [
          {
            qty: kind === 'purchase_return' ? lineQty : null,
            unitPrice: linePrice,
            taxRate: lineTaxRate ? lineTaxRate : null,
          },
        ],
        notes,
      };
      return await api<DebitNoteResponse>('/debit-notes', {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notesKey });
      setCreateOpen(false);
      resetForm();
    },
  });

  const issueMutation = useMutation({
    mutationFn: async (id: string) => {
      return await api<DebitNoteResponse>(`/debit-notes/${id}/issue`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: notesKey });
      setActiveNote(updated);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!activeNote) return;
      return await api<DebitNoteResponse>(`/debit-notes/${activeNote.id}/cancel`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { reason: cancelReason },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notesKey });
      setCancelOpen(false);
      setActiveNote(null);
      setCancelReason('');
    },
  });

  const resetForm = () => {
    setSupplierId('');
    setBillId('');
    setReason('');
    setLineQty('1');
    setLinePrice('');
    setNotes('');
  };

  const getStatusTone = (status: DebitNoteResponse['status']): StatusTone => {
    if (status === 'issued') return 'success';
    if (status === 'draft') return 'warning';
    return 'neutral';
  };

  const columns: Column<DebitNoteResponse>[] = [
    {
      key: 'number',
      header: 'Debit Note #',
      primary: true,
      render: (r) => (
        <button
          type="button"
          className="text-left font-semibold text-primary hover:underline font-mono"
          onClick={() => setActiveNote(r)}
        >
          {r.number ?? 'Draft'}
        </button>
      ),
    },
    { key: 'docDate', header: 'Date', render: (r) => formatBusinessDate(r.docDate) },
    { key: 'partyName', header: 'Supplier', render: (r) => r.partyName },
    { key: 'bill', header: 'Bill #', render: (r) => <span className="font-mono text-xs">{r.supplierBillNumber}</span> },
    {
      key: 'kind',
      header: 'Type',
      render: (r) => (
        <span className="capitalize text-xs font-medium px-2 py-0.5 rounded bg-surface-muted">
          {r.kind.replace('_', ' ')}
        </span>
      ),
    },
    { key: 'grand', header: 'Grand Total', align: 'end', render: (r) => <span className="tabular font-semibold">{formatINR(r.amounts.grand)}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge tone={getStatusTone(r.status)} label={r.status.toUpperCase()} />,
    },
  ];

  const header = (
    <PageHeader
      title="Debit Notes & Purchase Returns"
      description="Issue debit notes against supplier bills for return of goods or commercial price deductions."
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          + Issue Debit Note
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
          {notesQuery.isLoading ? (
            <div className="p-6"><Skeleton className="h-48" /></div>
          ) : (notesQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="No debit notes found"
              description="Issue a debit note to a supplier for returned inventory or price adjustments."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Issue Debit Note
                </Button>
              }
            />
          ) : (
            <DataTable
              caption="Debit Notes & Purchase Returns"
              hideCaption
              columns={columns}
              rows={notesQuery.data ?? []}
              rowKey={(r) => r.id}
            />
          )}
        </CardBody>
      </Card>

      {/* New Debit Note Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create Debit Note"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Adjustment Kind" required>
              {(f) => (
                <Select {...f} value={kind} onChange={(e) => setKind(e.target.value as any)}>
                  <option value="purchase_return">Purchase Return (Reduces Stock)</option>
                  <option value="price_adjustment">Commercial Price Adjustment</option>
                </Select>
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

          <FormField label="Supplier" required>
            {(f) => (
              <Select {...f} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setBillId(''); }}>
                <option value="">Select supplier...</option>
                {(suppliersQuery.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label="Original Supplier Bill" required>
            {(f) => (
              <Select {...f} value={billId} onChange={(e) => setBillId(e.target.value)} disabled={!supplierId}>
                <option value="">Select supplier bill...</option>
                {(billsQuery.data ?? []).map((bill) => (
                  <option key={bill.id} value={bill.id}>
                    {bill.number} ({bill.docDate}) — Total: ₹{bill.amounts.grand} (Out: ₹{bill.outstanding})
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label="Reason for Debit Note" required>
            {(f) => (
              <Input
                {...f}
                placeholder="e.g. Return of sub-standard batch, agreed discount"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </FormField>

          <div className="rounded border p-3 bg-surface-muted space-y-3">
            <div className="text-xs font-semibold text-muted uppercase tracking-wider">Line Item Adjustment</div>
            <div className="grid grid-cols-3 gap-3">
              {kind === 'purchase_return' && (
                <FormField label="Returned Qty" required>
                  {(f) => (
                    <Input
                      {...f}
                      type="number"
                      step="1"
                      min="1"
                      value={lineQty}
                      onChange={(e) => setLineQty(e.target.value)}
                    />
                  )}
                </FormField>
              )}

              <FormField label={kind === 'purchase_return' ? 'Unit Price (₹)' : 'Adjustment Value (₹)'} required>
                {(f) => (
                  <Input
                    {...f}
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={linePrice}
                    onChange={(e) => setLinePrice(e.target.value)}
                  />
                )}
              </FormField>

              <FormField label="GST Rate (%)">
                {(f) => (
                  <Select {...f} value={lineTaxRate} onChange={(e) => setLineTaxRate(e.target.value)}>
                    <option value="">0%</option>
                    <option value="5">5%</option>
                    <option value="12">12%</option>
                    <option value="18">18%</option>
                    <option value="28">28%</option>
                  </Select>
                )}
              </FormField>
            </div>
          </div>

          <FormField label="Notes">
            {(f) => (
              <Input
                {...f}
                placeholder="Optional notes"
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
              disabled={!supplierId || !billId || !reason.trim() || !linePrice || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Saving...' : 'Save Draft'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Debit Note Details Dialog */}
      {activeNote && (
        <Dialog
          open={Boolean(activeNote)}
          onOpenChange={(open) => !open && setActiveNote(null)}
          title={`Debit Note ${activeNote.number ?? 'Draft'}`}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <span className="text-xs text-muted">Supplier</span>
                <div className="font-semibold">{activeNote.partyName}</div>
                <div className="text-xs text-muted">Bill #{activeNote.supplierBillNumber}</div>
              </div>
              <div className="text-right">
                <StatusBadge tone={getStatusTone(activeNote.status)} label={activeNote.status.toUpperCase()} />
                <div className="text-xs text-muted mt-1 capitalize">{activeNote.kind.replace('_', ' ')}</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 rounded bg-surface-muted p-3 text-sm">
              <div>
                <span className="text-xs text-muted">Taxable</span>
                <div className="font-semibold tabular">{formatINR(activeNote.amounts.taxable)}</div>
              </div>
              <div>
                <span className="text-xs text-muted">GST Taxes</span>
                <div className="font-semibold tabular">
                  {formatINR(
                    (
                      parseFloat(activeNote.amounts.cgst) +
                      parseFloat(activeNote.amounts.sgst) +
                      parseFloat(activeNote.amounts.igst)
                    ).toFixed(2),
                  )}
                </div>
              </div>
              <div>
                <span className="text-xs text-muted">Grand Total</span>
                <div className="font-bold tabular text-base">{formatINR(activeNote.amounts.grand)}</div>
              </div>
            </div>

            <div className="text-sm">
              <span className="text-xs text-muted">Reason</span>
              <div>{activeNote.reason}</div>
            </div>

            <div className="flex justify-end gap-2 border-t pt-4">
              {activeNote.status === 'draft' && (
                <Button
                  variant="primary"
                  disabled={issueMutation.isPending}
                  onClick={() => issueMutation.mutate(activeNote.id)}
                >
                  {issueMutation.isPending ? 'Issuing...' : 'Issue Debit Note'}
                </Button>
              )}

              {activeNote.status === 'issued' && (
                <Button
                  variant="danger"
                  onClick={() => setCancelOpen(true)}
                >
                  Cancel Note
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      )}

      {/* Cancel Dialog */}
      {cancelOpen && activeNote && (
        <Dialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title="Cancel Debit Note"
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Cancelling this debit note will reverse the double-entry journal, restore the supplier bill payable balance, and rollback inventory movements.
            </p>
            <FormField label="Reason for Cancellation" required>
              {(f) => (
                <Input
                  {...f}
                  placeholder="e.g. Returned goods rejected by supplier"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                />
              )}
            </FormField>
            {cancelMutation.isError && (
              <div className="text-sm text-danger">{errorMessage(cancelMutation.error)}</div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setCancelOpen(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={!cancelReason.trim() || cancelMutation.isPending}
                onClick={() => cancelMutation.mutate()}
              >
                {cancelMutation.isPending ? 'Cancelling...' : 'Confirm Cancellation'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
