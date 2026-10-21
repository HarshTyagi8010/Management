import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { crmNoteSchema, crmTaskSchema, memberSchema, timelineEntrySchema, type CrmTask, type Party } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, StatusBadge, formatBusinessDate, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { formatDateTimeIST } from '../../app/permissions';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, listOf, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

const todayIST = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

function dueBadge(task: CrmTask) {
  if (task.status === 'done') return <StatusBadge tone="success" label="Done" />;
  if (task.status === 'cancelled') return <StatusBadge tone="neutral" label="Cancelled" />;
  const today = todayIST();
  if (task.dueDate < today) return <StatusBadge tone="danger" label="Overdue" />;
  if (task.dueDate === today) return <StatusBadge tone="warning" label="Today" />;
  return <StatusBadge tone="info" label="Upcoming" />;
}

/** Members to assign follow-ups to. Only users.manage holders can list members, so others assign to themselves. */
function useAssignees() {
  const { can } = useSession();
  const key = useTenantQueryKey('members');
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api('/members', { schema: listOf(memberSchema), signal }).then((r) => r.data.filter((m) => m.status === 'active')), enabled: can('users.manage') });
}

function useCompleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ task, status }: { task: CrmTask; status: CrmTask['status'] }) => api(`/crm-tasks/${task.id}`, { method: 'PATCH', body: { version: task.version, status }, schema: crmTaskSchema }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tenant'] }),
  });
}

export function PartyTimeline({ party }: { party: Party }) {
  const { can } = useSession();
  const key = useTenantQueryKey('parties', party.id, 'timeline');
  const timeline = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/parties/${party.id}/timeline`, { schema: listOf(timelineEntrySchema), signal }).then((r) => r.data) });
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const complete = useCompleteTask();
  const crm = can('crm.tasks');
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader title="Timeline" />
        <CardBody>
          {timeline.isPending ? (
            <Skeleton className="h-32" />
          ) : timeline.isError ? (
            <InlineAlert>{errorMessage(timeline.error)}</InlineAlert>
          ) : timeline.data.length === 0 ? (
            <EmptyState title="Nothing yet" description="Notes and follow-ups for this party appear here." />
          ) : (
            <ol className="flex flex-col gap-3" aria-label="Notes and follow-ups, newest first">
              {timeline.data.map((entry) =>
                entry.kind === 'note' ? (
                  <li key={`n${entry.note.id}`} className="rounded-md border border-border p-3">
                    <p className="text-sm whitespace-pre-wrap">{entry.note.body}</p>
                    <p className="mt-1 text-xs text-muted">
                      Note by {entry.note.author} · {formatDateTimeIST(entry.note.createdAt)}
                    </p>
                  </li>
                ) : (
                  <li key={`t${entry.task.id}`} className="rounded-md border border-border p-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {entry.task.title} {dueBadge(entry.task)}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Follow-up due {formatBusinessDate(entry.task.dueDate)} · {entry.task.assignee.name}
                    </p>
                    {crm && entry.task.status === 'open' && (
                      <Button size="sm" variant="secondary" className="mt-2" onClick={() => complete.mutate({ task: entry.task, status: 'done' })} disabled={complete.isPending}>
                        Mark done
                      </Button>
                    )}
                  </li>
                ),
              )}
            </ol>
          )}
        </CardBody>
      </Card>
      {crm && (
        <div className="flex flex-col gap-6">
          <NoteForm partyId={party.id} onSaved={refresh} />
          <TaskForm partyId={party.id} onSaved={refresh} />
        </div>
      )}
    </div>
  );
}

function NoteForm({ partyId, onSaved }: { partyId: string; onSaved: () => void }) {
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => api(`/parties/${partyId}/notes`, { method: 'POST', body: { body }, schema: crmNoteSchema }),
    onSuccess: () => {
      setBody('');
      onSaved();
    },
  });
  return (
    <Card>
      <CardHeader title="Add a note" description="Notes can't be edited later; add another note to correct one." />
      <CardBody>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
          className="flex flex-col gap-3"
        >
          {add.isError && <InlineAlert>{errorMessage(add.error)}</InlineAlert>}
          <FormField label="Note" required>
            {(f) => <textarea {...f} rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm" />}
          </FormField>
          <div>
            <Button type="submit" size="sm" disabled={add.isPending || !body.trim()}>
              Add note
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function TaskForm({ partyId, onSaved }: { partyId: string; onSaved: () => void }) {
  const { session } = useSession();
  const assignees = useAssignees();
  const me = session.status === 'authenticated' ? session.user.id : '';
  const [title, setTitle] = useState('');
  const [dueDate, setDue] = useState(todayIST());
  const [assigneeId, setAssignee] = useState(me);
  const add = useMutation({
    mutationFn: () => api(`/parties/${partyId}/tasks`, { method: 'POST', body: { title, dueDate, assigneeId: assigneeId || null }, schema: crmTaskSchema }),
    onSuccess: () => {
      setTitle('');
      onSaved();
    },
  });
  const errors = fieldErrorsOf(add.error);
  return (
    <Card>
      <CardHeader title="Add a follow-up" />
      <CardBody>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
          className="flex flex-col gap-3"
        >
          {add.isError && <InlineAlert>{errorMessage(add.error)}</InlineAlert>}
          <FormField label="What to do" required error={errors.title}>
            {(f) => <Input {...f} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </FormField>
          <FormField label="Due" required error={errors.dueDate}>
            {(f) => <Input {...f} type="date" value={dueDate} onChange={(e) => setDue(e.target.value)} />}
          </FormField>
          {assignees.data && (
            <FormField label="Assign to" error={errors.assigneeId}>
              {(f) => (
                <Select {...f} value={assigneeId} onChange={(e) => setAssignee(e.target.value)}>
                  {assignees.data.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                      {m.isSelf ? ' (you)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          )}
          <div>
            <Button type="submit" size="sm" disabled={add.isPending || !title.trim() || !dueDate}>
              Add follow-up
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function FollowUpsPage() {
  usePageTitle('Follow-ups');
  const { can, tenantContext } = useSession();
  const [assignee, setWho] = useState<'me' | 'anyone'>('me');
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const allowed = can('crm.tasks');
  const key = useTenantQueryKey('crm-tasks', assignee, status);
  const tasks = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/crm-tasks?assignee=${assignee}&status=${status}`, { schema: z.object({ data: z.array(crmTaskSchema) }), signal }).then((r) => r.data), enabled: allowed });
  const complete = useCompleteTask();

  const header = <PageHeader title="Follow-ups" description="Calls, visits and reminders for your customers and suppliers." />;
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-40" /></>;
  if (!allowed) return <>{header}<Card className="mt-6"><PermissionDenied permission="crm.tasks" /></Card></>;

  const columns: Column<CrmTask>[] = [
    { key: 'due', header: 'Due', render: (t) => <span className="flex flex-wrap items-center gap-2 whitespace-nowrap"><span className="tabular">{formatBusinessDate(t.dueDate)}</span>{dueBadge(t)}</span> },
    { key: 'title', header: 'Follow-up', primary: true, render: (t) => <span className="font-medium">{t.title}</span> },
    { key: 'party', header: 'With', render: (t) => <Link to={`/parties/${t.partyId}`} className="text-accent underline-offset-2 hover:underline">{t.partyName}</Link> },
    { key: 'who', header: 'Assigned to', render: (t) => t.assignee.name },
    {
      key: 'actions',
      header: 'Actions',
      render: (t) =>
        t.status === 'open' ? (
          <Button size="sm" variant="secondary" onClick={() => complete.mutate({ task: t, status: 'done' })} disabled={complete.isPending} aria-label={`Mark done: ${t.title}`}>
            Mark done
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      {header}
      <Card className="mt-6">
        <div className="flex flex-wrap gap-4 px-5 pt-5">
          <FormField label="Whose" className="w-40">
            {(f) => (
              <Select {...f} value={assignee} onChange={(e) => setWho(e.target.value as 'me' | 'anyone')}>
                <option value="me">Mine</option>
                <option value="anyone">Everyone’s</option>
              </Select>
            )}
          </FormField>
          <FormField label="Status" className="w-40">
            {(f) => (
              <Select {...f} value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'done')}>
                <option value="open">Open</option>
                <option value="done">Done</option>
              </Select>
            )}
          </FormField>
        </div>
        {complete.isError && <InlineAlert className="mx-5 mt-4">{errorMessage(complete.error)}</InlineAlert>}
        <div className="py-4">
          {tasks.isPending ? (
            <Skeleton className="mx-5 h-32" />
          ) : tasks.isError ? (
            <ErrorState message={errorMessage(tasks.error)} onRetry={() => void tasks.refetch()} />
          ) : (
            <DataTable caption="Follow-ups" hideCaption columns={columns} rows={tasks.data} rowKey={(t) => t.id} empty={<EmptyState title={status === 'open' ? 'Nothing to follow up' : 'No completed follow-ups'} description="Add follow-ups from a customer or supplier page." />} />
          )}
        </div>
      </Card>
    </>
  );
}
