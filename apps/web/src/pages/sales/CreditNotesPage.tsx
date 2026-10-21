import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  CreditNoteResponse,
  Party,
  SalesDocument,
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

export function CreditNotesPage() {
  usePageTitle('Credit Notes & Sales Returns');
  const { can, canIn, tenantContext } = useSession();
  const queryClient = useQueryClient();
  const entities = useLegalEntities();
  const allowed = (entities.data ?? []).filter((e) =>
    canIn('note.issue', e.id) || canIn('report.financial', e.id),
  );

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';
  const [createOpen, setCreateOpen] = useState(false);
  const [activeNote, setActiveNote] = useState<CreditNoteResponse | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  // Form states
  const [customerId, setCustomerId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [kind, setKind] = useState<'sales_return' | 'price_adjustment'>('sales_return');
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [lineQty, setLineQty] = useState('1');
  const [linePrice, setLinePrice] = useState('');
  const [lineTaxRate, setLineTaxRate] = useState('18');
  const [notes, setNotes] = useState('');

  const notesKey = useTenantQueryKey('credit-notes', chosenEntity);
  const notesQuery = useQuery({
    queryKey: notesKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: CreditNoteResponse[] }>(
        `/credit-notes${chosenEntity ? `?legalEntityId=${chosenEntity}` : ''}`,
        { signal },
      );
      return res.data;
    },
    enabled: Boolean(chosenEntity),
  });

  // Fetch customers
  const customersKey = useTenantQueryKey('parties', 'customers');
  const customersQuery = useQuery({
    queryKey: customersKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: Party[] }>('/parties?role=customer', { signal });
      return res.data;
    },
  });

  // Fetch customer invoices
  const invoicesKey = useTenantQueryKey('customer-invoices', customerId, chosenEntity);
  const invoicesQuery = useQuery({
    queryKey: invoicesKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: SalesDocument[] }>(
        `/sales-invoices?partyId=${customerId}&legalEntityId=${chosenEntity}&status=issued`,
        { signal },
      );
      return res.data;
    },
    enabled: Boolean(customerId && chosenEntity && createOpen),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        legalEntityId: chosenEntity,
        partyId: customerId,
        salesInvoiceId: invoiceId,
        kind,
        docDate,
        reason,
        lines: [
          {
            qty: kind === 'sales_return' ? lineQty : null,
            unitPrice: linePrice,
            taxRate: lineTaxRate ? lineTaxRate : null,
          },
        ],
        notes,
      };
      return await api<CreditNoteResponse>('/credit-notes', {
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
      return await api<CreditNoteResponse>(`/credit-notes/${id}/issue`, {
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
      return await api<CreditNoteResponse>(`/credit-notes/${activeNote.id}/cancel`, {
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
    setCustomerId('');
    setInvoiceId('');
    setReason('');
    setLineQty('1');
    setLinePrice('');
    setNotes('');
  };

  const getStatusTone = (status: CreditNoteResponse['status']): StatusTone => {
    if (status === 'issued') return 'success';
    if (status === 'draft') return 'warning';
    return 'neutral';
  };

  const columns: Column<CreditNoteResponse>[] = [
    {
      key: 'number',
      header: 'Credit Note #',
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
    { key: 'partyName', header: 'Customer', render: (r) => r.partyName },
    { key: 'invoice', header: 'Invoice #', render: (r) => <span className="font-mono text-xs">{r.salesInvoiceNumber}</span> },
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
      title="Credit Notes & Sales Returns"
      description="Issue credit notes against tax invoices for sales returns (with automated stock restoration) or price adjustments."
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          + Issue Credit Note
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
              title="No credit notes found"
              description="Issue a credit note against an existing sales invoice for returns or commercial adjustments."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Issue Credit Note
                </Button>
              }
            />
          ) : (
            <DataTable
              caption="Credit Notes & Sales Returns"
              hideCaption
              columns={columns}
              rows={notesQuery.data ?? []}
              rowKey={(r) => r.id}
            />
          )}
        </CardBody>
      </Card>

      {/* New Credit Note Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create Credit Note"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Adjustment Kind" required>
              {(f) => (
                <Select {...f} value={kind} onChange={(e) => setKind(e.target.value as any)}>
                  <option value="sales_return">Sales Return (Restores Stock)</option>
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

          <FormField label="Customer" required>
            {(f) => (
              <Select {...f} value={customerId} onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(''); }}>
                <option value="">Select customer...</option>
                {(customersQuery.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label="Original Sales Invoice" required>
            {(f) => (
              <Select {...f} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={!customerId}>
                <option value="">Select sales invoice...</option>
                {(invoicesQuery.data ?? []).map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.number} ({inv.docDate}) — Total: ₹{inv.totals?.grand} (Out: ₹{inv.outstanding})
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label="Reason for Credit Note" required>
            {(f) => (
              <Input
                {...f}
                placeholder="e.g. Goods damaged in transit, overcharged price"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </FormField>

          <div className="rounded border p-3 bg-surface-muted space-y-3">
            <div className="text-xs font-semibold text-muted uppercase tracking-wider">Line Item Adjustment</div>
            <div className="grid grid-cols-3 gap-3">
              {kind === 'sales_return' && (
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

              <FormField label={kind === 'sales_return' ? 'Unit Price (₹)' : 'Adjustment Value (₹)'} required>
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
              disabled={!customerId || !invoiceId || !reason.trim() || !linePrice || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Saving...' : 'Save Draft'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Credit Note Details Dialog */}
      {activeNote && (
        <Dialog
          open={Boolean(activeNote)}
          onOpenChange={(open) => !open && setActiveNote(null)}
          title={`Credit Note ${activeNote.number ?? 'Draft'}`}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <span className="text-xs text-muted">Customer</span>
                <div className="font-semibold">{activeNote.partyName}</div>
                <div className="text-xs text-muted">Invoice #{activeNote.salesInvoiceNumber}</div>
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
                  {issueMutation.isPending ? 'Issuing...' : 'Issue Credit Note'}
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
          title="Cancel Credit Note"
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Cancelling this credit note will reverse the double-entry journal, restore the customer invoice balance, and rollback restored inventory movements.
            </p>
            <FormField label="Reason for Cancellation" required>
              {(f) => (
                <Input
                  {...f}
                  placeholder="e.g. Issued in error"
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
