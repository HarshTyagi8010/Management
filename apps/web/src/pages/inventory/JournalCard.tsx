import { useQuery } from '@tanstack/react-query';
import { journalSchema, type Journal } from '@bizmgmt/contracts';
import { Card, CardHeader, DataTable, Skeleton, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { api } from '../../lib/api';
import { pageSchemaOf, useTenantQueryKey } from '../../lib/queries';
import { rupees } from './shared';

type Line = Journal['lines'][number];

/** The accounting entry a posted document made (internal books, ADR-011). Shown to people with financial reports. */
export function JournalCard({ legalEntityId, sourceId }: { legalEntityId: string; sourceId: string }) {
  const { canIn } = useSession();
  const allowed = canIn('report.financial', legalEntityId);
  const key = useTenantQueryKey('journals', sourceId);
  const journals = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/journals?legalEntityId=${legalEntityId}&sourceId=${sourceId}`, { schema: pageSchemaOf(journalSchema), signal }).then((r) => r.data),
    enabled: allowed,
  });
  if (!allowed) return null;
  const columns: Column<Line>[] = [
    { key: 'account', header: 'Account', primary: true, render: (l) => `${l.accountCode} · ${l.accountName}` },
    { key: 'debit', header: 'Debit', align: 'end', render: (l) => <span className="tabular">{l.debit === '0.00' ? '' : rupees(l.debit)}</span> },
    { key: 'credit', header: 'Credit', align: 'end', render: (l) => <span className="tabular">{l.credit === '0.00' ? '' : rupees(l.credit)}</span> },
  ];
  const journal = journals.data?.[0];
  return (
    <Card className="mt-6">
      <CardHeader title="Accounting entry" description="Internal books used for ledgers and checks; not a statutory statement." />
      <div className="py-4">
        {journals.isPending ? (
          <Skeleton className="mx-5 h-20" />
        ) : journal ? (
          <DataTable caption={`Journal for ${journal.sourceNumber}`} hideCaption columns={columns} rows={journal.lines} rowKey={(l) => `${l.accountCode}-${l.debit}-${l.credit}`} />
        ) : (
          <p className="px-5 text-sm text-muted">No accounting entry: nothing of value changed.</p>
        )}
      </div>
    </Card>
  );
}
