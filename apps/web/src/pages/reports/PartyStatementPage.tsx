import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Party, PartyStatementResponse } from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  FormField,
  Input,
  Select,
  Skeleton,
  formatBusinessDate,
  formatINR,
  type Column,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

type StatementEntry = PartyStatementResponse['entries'][number];

export function PartyStatementPage() {
  usePageTitle('Party Running Balance Statement');
  const { tenantContext } = useSession();
  const entities = useLegalEntities();
  const allowed = entities.data ?? [];

  const [selectedEntityId, setSelectedEntityId] = useState('');
  const chosenEntity = selectedEntityId || allowed[0]?.id || '';

  const [role, setRole] = useState<'customer' | 'supplier'>('customer');
  const [partyId, setPartyId] = useState('');

  // Default to 1st of current month to today
  const [from, setFrom] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const partiesKey = useTenantQueryKey('parties', role);
  const partiesQuery = useQuery({
    queryKey: partiesKey,
    queryFn: async ({ signal }) => {
      const res = await api<{ data: Party[] }>(`/parties?role=${role}`, { signal });
      return res.data;
    },
  });

  const statementKey = useTenantQueryKey('statement', chosenEntity, partyId, from, to);
  const statementQuery = useQuery({
    queryKey: statementKey,
    queryFn: async ({ signal }) => {
      const res = await api<PartyStatementResponse>(
        `/parties/${partyId}/statement?legalEntityId=${chosenEntity}&from=${from}&to=${to}`,
        { signal },
      );
      return res;
    },
    enabled: Boolean(chosenEntity && partyId && from && to),
  });

  const statement = statementQuery.data;

  const columns: Column<StatementEntry>[] = [
    { key: 'date', header: 'Date', render: (r) => formatBusinessDate(r.date) },
    { key: 'type', header: 'Type', render: (r) => <span className="capitalize text-xs font-medium">{r.docType.replace('_', ' ')}</span> },
    { key: 'number', header: 'Document #', render: (r) => <span className="font-mono text-xs">{r.docNumber}</span> },
    { key: 'desc', header: 'Description', render: (r) => r.description },
    {
      key: 'debit',
      header: 'Debit (₹)',
      align: 'end',
      render: (r) => (
        <span className={parseFloat(r.debit) > 0 ? 'font-medium tabular' : 'text-muted tabular'}>
          {parseFloat(r.debit) > 0 ? formatINR(r.debit) : '—'}
        </span>
      ),
    },
    {
      key: 'credit',
      header: 'Credit (₹)',
      align: 'end',
      render: (r) => (
        <span className={parseFloat(r.credit) > 0 ? 'font-medium tabular' : 'text-muted tabular'}>
          {parseFloat(r.credit) > 0 ? formatINR(r.credit) : '—'}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Running Balance (₹)',
      align: 'end',
      render: (r) => <span className="tabular font-bold">{formatINR(r.runningBalance)}</span>,
    },
  ];

  const header = (
    <PageHeader
      title="Party Statement"
      description="View running balance account statements for customers and suppliers with chronological debits and credits."
      actions={
        <Button variant="secondary" onClick={() => window.print()} disabled={!statement}>
          Print Statement
        </Button>
      }
    />
  );

  if (!tenantContext || entities.isPending) return <>{header}<Skeleton className="mt-6 h-64" /></>;

  return (
    <>
      {header}

      <Card className="mt-6">
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {allowed.length > 1 && (
            <FormField label="Legal Entity">
              {(f) => (
                <Select {...f} value={chosenEntity} onChange={(e) => setSelectedEntityId(e.target.value)}>
                  {allowed.map((e) => (
                    <option key={e.id} value={e.id}>{e.legalName}</option>
                  ))}
                </Select>
              )}
            </FormField>
          )}

          <FormField label="Party Role">
            {(f) => (
              <Select
                {...f}
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as any);
                  setPartyId('');
                }}
              >
                <option value="customer">Customer</option>
                <option value="supplier">Supplier</option>
              </Select>
            )}
          </FormField>

          <FormField label={role === 'customer' ? 'Customer' : 'Supplier'}>
            {(f) => (
              <Select {...f} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                <option value="">Select party...</option>
                {(partiesQuery.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            )}
          </FormField>

          <FormField label="From Date">
            {(f) => <Input {...f} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </FormField>

          <FormField label="To Date">
            {(f) => <Input {...f} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
          </FormField>
        </CardBody>
      </Card>

      {statement && (
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Card className="bg-surface-muted">
            <CardBody className="p-4">
              <span className="text-xs font-semibold text-muted uppercase tracking-wider">Opening Balance</span>
              <div className="mt-1 text-2xl font-bold">{formatINR(statement.openingBalance)}</div>
            </CardBody>
          </Card>
          <Card className="bg-surface-muted">
            <CardBody className="p-4">
              <span className="text-xs font-semibold text-muted uppercase tracking-wider">Total Debits</span>
              <div className="mt-1 text-2xl font-bold text-accent">{formatINR(statement.totalDebit)}</div>
            </CardBody>
          </Card>
          <Card className="bg-surface-muted">
            <CardBody className="p-4">
              <span className="text-xs font-semibold text-muted uppercase tracking-wider">Total Credits</span>
              <div className="mt-1 text-2xl font-bold text-success">{formatINR(statement.totalCredit)}</div>
            </CardBody>
          </Card>
          <Card className="bg-surface-muted">
            <CardBody className="p-4">
              <span className="text-xs font-semibold text-muted uppercase tracking-wider">Closing Balance</span>
              <div className="mt-1 text-2xl font-bold text-text">{formatINR(statement.closingBalance)}</div>
            </CardBody>
          </Card>
        </div>
      )}

      <Card className="mt-6">
        <CardBody className="p-0">
          {!partyId ? (
            <div className="p-8 text-center text-sm text-muted">
              Select a {role} and date range to generate their account statement.
            </div>
          ) : statementQuery.isLoading ? (
            <div className="p-6"><Skeleton className="h-64" /></div>
          ) : (statement?.entries ?? []).length === 0 ? (
            <EmptyState
              title="No transactions found"
              description={`No transactions found for ${statement?.partyName} between ${formatBusinessDate(from)} and ${formatBusinessDate(to)}.`}
            />
          ) : (
            <DataTable
              caption="Party Running Balance Statement"
              hideCaption
              columns={columns}
              rows={statement?.entries ?? []}
              rowKey={(r) => `${r.date}-${r.docNumber}-${r.docType}`}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}
