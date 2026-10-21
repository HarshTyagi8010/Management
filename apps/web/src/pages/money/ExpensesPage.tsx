import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ExpenseResponse, ExpensePaymentMode } from '@bizmgmt/contracts';
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

export function ExpensesPage() {
  usePageTitle('Direct Expenses');
  const { can, canIn, tenantContext } = useSession();
  const queryClient = useQueryClient();
  const entities = useLegalEntities();
  const allowed = (entities.data ?? []).filter((e) =>
    canIn('expense.post', e.id) || canIn('report.financial', e.id),
  );

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [activeExpense, setActiveExpense] = useState<ExpenseResponse | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  // Form states
  const [category, setCategory] = useState('Office Supplies');
  const [description, setDescription] = useState('');
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [taxRate, setTaxRate] = useState('18');
  const [itcEligible, setItcEligible] = useState(false);
  const [payeeName, setPayeeName] = useState('');
  const [paymentMode, setPaymentMode] = useState<ExpensePaymentMode>('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const expensesKey = useTenantQueryKey('expenses', chosenEntity);
  const expensesQuery = useQuery({
    queryKey: expensesKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: ExpenseResponse[] }>(
        `/expenses${chosenEntity ? `?legalEntityId=${chosenEntity}` : ''}`,
        { signal },
      );
      return res.data;
    },
    enabled: Boolean(chosenEntity),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        legalEntityId: chosenEntity,
        category,
        description,
        docDate,
        amount,
        taxRate: taxRate ? taxRate : null,
        itcEligible,
        payeeName: payeeName || null,
        paymentMode,
        reference: reference || null,
        notes,
      };
      return await api<ExpenseResponse>('/expenses', {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: expensesKey });
      setCreateOpen(false);
      resetForm();
    },
  });

  const postMutation = useMutation({
    mutationFn: async (id: string) => {
      return await api<ExpenseResponse>(`/expenses/${id}/post`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: expensesKey });
      setActiveExpense(null);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!activeExpense) return;
      return await api<ExpenseResponse>(`/expenses/${activeExpense.id}/cancel`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { reason: cancelReason },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: expensesKey });
      setCancelOpen(false);
      setActiveExpense(null);
      setCancelReason('');
    },
  });

  const resetForm = () => {
    setDescription('');
    setAmount('');
    setReference('');
    setNotes('');
    setPayeeName('');
  };

  const getStatusTone = (status: ExpenseResponse['status']): StatusTone => {
    if (status === 'posted') return 'success';
    if (status === 'draft') return 'warning';
    return 'neutral';
  };

  const columns: Column<ExpenseResponse>[] = [
    {
      key: 'number',
      header: 'Expense #',
      primary: true,
      render: (r) => (
        <button
          type="button"
          className="text-left font-semibold text-primary hover:underline font-mono"
          onClick={() => setActiveExpense(r)}
        >
          {r.number ?? 'Draft'}
        </button>
      ),
    },
    { key: 'docDate', header: 'Date', render: (r) => formatBusinessDate(r.docDate) },
    { key: 'category', header: 'Category', render: (r) => <span className="font-medium">{r.category}</span> },
    { key: 'description', header: 'Description', render: (r) => r.description },
    { key: 'payee', header: 'Payee', render: (r) => r.payeeName ?? '—' },
    { key: 'mode', header: 'Payment Mode', render: (r) => <span className="capitalize">{r.paymentMode.replace('_', ' ')}</span> },
    { key: 'amount', header: 'Total (₹)', align: 'end', render: (r) => <span className="tabular font-semibold">{formatINR(r.amount)}</span> },
    {
      key: 'tax',
      header: 'Tax (₹)',
      align: 'end',
      render: (r) => (
        <span className="tabular text-xs text-muted">
          {formatINR(r.taxAmount)} {r.itcEligible ? '(ITC)' : ''}
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
      title="Direct Expenses"
      description="Record non-PO operating expenses, travel, utility, and petty cash disbursements with GST ITC breakdown."
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          + Record Expense
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
          {expensesQuery.isLoading ? (
            <div className="p-6"><Skeleton className="h-48" /></div>
          ) : (expensesQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="No expenses recorded"
              description="Record your first operating expense or office supply disbursement."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Record Expense
                </Button>
              }
            />
          ) : (
            <DataTable
              caption="Direct Expenses"
              hideCaption
              columns={columns}
              rows={expensesQuery.data ?? []}
              rowKey={(r) => r.id}
            />
          )}
        </CardBody>
      </Card>

      {/* New Expense Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Record Direct Expense"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Category" required>
              {(f) => (
                <Select {...f} value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="Office Supplies">Office Supplies</option>
                  <option value="Travel & Conveyance">Travel & Conveyance</option>
                  <option value="Rent & Utilities">Rent & Utilities</option>
                  <option value="Professional Fees">Professional Fees</option>
                  <option value="Repairs & Maintenance">Repairs & Maintenance</option>
                  <option value="Advertising & Marketing">Advertising & Marketing</option>
                  <option value="Miscellaneous">Miscellaneous</option>
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

          <FormField label="Description" required>
            {(f) => (
              <Input
                {...f}
                placeholder="e.g. Printer paper and ink cartridge replenishment"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Total Gross Amount (₹)" required>
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

            <FormField label="GST Tax Rate">
              {(f) => (
                <Select {...f} value={taxRate} onChange={(e) => setTaxRate(e.target.value)}>
                  <option value="">Exempt / 0%</option>
                  <option value="5">5% GST</option>
                  <option value="12">12% GST</option>
                  <option value="18">18% GST</option>
                  <option value="28">28% GST</option>
                </Select>
              )}
            </FormField>
          </div>

          <div className="flex items-center gap-2 rounded border p-3 bg-surface-muted">
            <input
              type="checkbox"
              id="itcEligible"
              checked={itcEligible}
              onChange={(e) => setItcEligible(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <label htmlFor="itcEligible" className="text-sm font-medium cursor-pointer">
              Eligible for Input Tax Credit (ITC) under GST
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Payee Name">
              {(f) => (
                <Input
                  {...f}
                  placeholder="Vendor / Store name"
                  value={payeeName}
                  onChange={(e) => setPayeeName(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Payment Mode" required>
              {(f) => (
                <Select {...f} value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as ExpensePaymentMode)}>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cash">Cash</option>
                  <option value="payable">Payable (Accrual)</option>
                </Select>
              )}
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Bill / Receipt Reference #">
              {(f) => (
                <Input
                  {...f}
                  placeholder="Invoice # or voucher ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Notes">
              {(f) => (
                <Input
                  {...f}
                  placeholder="Internal notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              )}
            </FormField>
          </div>

          {createMutation.isError && (
            <div className="text-sm text-danger">{errorMessage(createMutation.error)}</div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!description.trim() || !amount || parseFloat(amount) <= 0 || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Saving...' : 'Save Draft'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Expense Details Dialog */}
      {activeExpense && (
        <Dialog
          open={Boolean(activeExpense)}
          onOpenChange={(open) => !open && setActiveExpense(null)}
          title={`Expense ${activeExpense.number ?? 'Draft'}`}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <span className="text-xs text-muted">Category</span>
                <div className="font-semibold">{activeExpense.category}</div>
              </div>
              <div><StatusBadge tone={getStatusTone(activeExpense.status)} label={activeExpense.status.toUpperCase()} /></div>
            </div>

            <div className="grid grid-cols-3 gap-3 rounded bg-surface-muted p-3 text-sm">
              <div>
                <span className="text-xs text-muted">Taxable</span>
                <div className="font-semibold tabular">{formatINR(activeExpense.taxableAmount)}</div>
              </div>
              <div>
                <span className="text-xs text-muted">Tax ({activeExpense.taxRate ? `${activeExpense.taxRate}%` : '0%'})</span>
                <div className="font-semibold tabular">{formatINR(activeExpense.taxAmount)}</div>
              </div>
              <div>
                <span className="text-xs text-muted">Total</span>
                <div className="font-bold tabular text-base">{formatINR(activeExpense.amount)}</div>
              </div>
            </div>

            <div className="text-sm">
              <span className="text-xs text-muted">Description</span>
              <div>{activeExpense.description}</div>
            </div>

            {activeExpense.reference && (
              <div className="text-sm">
                <span className="text-xs text-muted">Reference</span>
                <div className="font-mono">{activeExpense.reference}</div>
              </div>
            )}

            <div className="flex justify-end gap-2 border-t pt-4">
              {activeExpense.status === 'draft' && (
                <Button
                  variant="primary"
                  disabled={postMutation.isPending}
                  onClick={() => postMutation.mutate(activeExpense.id)}
                >
                  {postMutation.isPending ? 'Posting...' : 'Post to Ledger'}
                </Button>
              )}

              {activeExpense.status === 'posted' && (
                <Button
                  variant="danger"
                  onClick={() => setCancelOpen(true)}
                >
                  Cancel Expense
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      )}

      {/* Cancel Expense Dialog */}
      {cancelOpen && activeExpense && (
        <Dialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title="Cancel Expense Entry"
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Cancelling this expense posts a double-entry mirror reversal journal in the current period and marks the expense as cancelled.
            </p>
            <FormField label="Reason for Cancellation" required>
              {(f) => (
                <Input
                  {...f}
                  placeholder="e.g. Invoiced separately by supplier"
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
