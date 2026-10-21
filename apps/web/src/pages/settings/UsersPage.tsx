import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { invitationSchema, memberSchema, roleSchema, type Invitation, type Member, type Role } from '@bizmgmt/contracts';
import { Button, Card, Checkbox, DataTable, Dialog, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useStepUp } from '../../auth/StepUp';
import { useSession } from '../../auth/session';
import { formatDateTimeIST } from '../../app/permissions';
import { api, ApiError } from '../../lib/api';
import { listOf, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { useWarehouses, warehouseLabel } from '../inventory/shared';
import { RolesTab } from './RolesTab';

export function useRoles() {
  const key = useTenantQueryKey('roles');
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api('/roles', { schema: listOf(roleSchema), signal }).then((r) => r.data) });
}

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

const tabTrigger =
  'inline-flex h-10 cursor-pointer items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted data-[state=active]:border-accent data-[state=active]:text-text';

export function UsersPage() {
  usePageTitle('Users & roles');
  const { can, tenantContext } = useSession();

  if (!tenantContext) {
    return (
      <>
        <h1 className="text-xl font-semibold">Users &amp; roles</h1>
        <Skeleton className="mt-6 h-64 w-full" />
      </>
    );
  }
  const people = can('users.manage');
  const roles = can('roles.manage') || people;

  return (
    <>
      <h1 className="text-xl font-semibold">Users &amp; roles</h1>
      <p className="mt-1 text-sm text-muted">Who can use {tenantContext.tenant.name}, and what each role allows.</p>
      {!roles ? (
        <Card className="mt-6">
          <PermissionDenied permission="users.manage" />
        </Card>
      ) : (
        <Tabs.Root defaultValue={people ? 'members' : 'roles'} className="mt-6">
          <Tabs.List aria-label="Users and roles" className="flex gap-1 overflow-x-auto border-b border-border">
            {people && (
              <Tabs.Trigger value="members" className={tabTrigger}>
                People
              </Tabs.Trigger>
            )}
            {people && (
              <Tabs.Trigger value="invitations" className={tabTrigger}>
                Invitations
              </Tabs.Trigger>
            )}
            <Tabs.Trigger value="roles" className={tabTrigger}>
              Roles
            </Tabs.Trigger>
          </Tabs.List>
          {people && (
            <Tabs.Content value="members" className="mt-4 focus:outline-none">
              <MembersTab />
            </Tabs.Content>
          )}
          {people && (
            <Tabs.Content value="invitations" className="mt-4 focus:outline-none">
              <InvitationsTab />
            </Tabs.Content>
          )}
          <Tabs.Content value="roles" className="mt-4 focus:outline-none">
            <RolesTab canEdit={can('roles.manage')} />
          </Tabs.Content>
        </Tabs.Root>
      )}
    </>
  );
}

function RoleChecklist({ roles, selected, onChange, legend }: { roles: Role[]; selected: string[]; onChange: (ids: string[]) => void; legend: string }) {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-2 text-[0.8125rem] font-medium">{legend}</legend>
      {roles.map((role) => (
        <Checkbox
          key={role.id}
          label={role.name}
          description={role.description}
          checked={selected.includes(role.id)}
          onChange={(e) => onChange(e.target.checked ? [...selected, role.id] : selected.filter((id) => id !== role.id))}
        />
      ))}
    </fieldset>
  );
}

/**
 * Which business entities the roles apply to (FR-RBAC-03). Hidden when the
 * business has only one entity, since "all" and "this one" are then the same.
 */
function EntityScopeField({ value, onChange }: { value: string[] | null; onChange: (next: string[] | null) => void }) {
  const entities = useLegalEntities();
  if (!entities.data || entities.data.length < 2) return null;
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-2 text-[0.8125rem] font-medium">Business entities</legend>
      <Checkbox label="All business entities" description="Includes entities added later." checked={value === null} onChange={(e) => onChange(e.target.checked ? null : [])} />
      {value !== null &&
        entities.data.map((e) => (
          <Checkbox
            key={e.id}
            label={e.legalName}
            checked={value.includes(e.id)}
            onChange={(ev) => onChange(ev.target.checked ? [...value, e.id] : value.filter((id) => id !== e.id))}
            className="ml-6"
          />
        ))}
    </fieldset>
  );
}

/**
 * Which warehouses stock permissions apply to (FR-RBAC-03), e.g. a storekeeper
 * who works in one godown. Only warehouses of the chosen entities are offered.
 */
function WarehouseScopeField({ value, onChange, entityIds }: { value: string[] | null; onChange: (next: string[] | null) => void; entityIds: string[] | null }) {
  const warehouses = useWarehouses();
  const options = (warehouses.data ?? []).filter((w) => !w.archived && (entityIds === null || entityIds.includes(w.legalEntityId)));
  if (options.length < 2 && value === null) return null;
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-2 text-[0.8125rem] font-medium">Warehouses</legend>
      <Checkbox label="All warehouses" description="Stock access in every warehouse of the entities above, including ones added later." checked={value === null} onChange={(e) => onChange(e.target.checked ? null : [])} />
      {value !== null &&
        options.map((w) => (
          <Checkbox key={w.id} label={warehouseLabel(w)} checked={value.includes(w.id)} onChange={(ev) => onChange(ev.target.checked ? [...value, w.id] : value.filter((id) => id !== w.id))} className="ml-6" />
        ))}
    </fieldset>
  );
}

function MembersTab() {
  const key = useTenantQueryKey('members');
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const members = useQuery({ queryKey: key, queryFn: ({ signal }) => api('/members', { schema: listOf(memberSchema), signal }).then((r) => r.data) });
  const [editing, setEditing] = useState<Member | null>(null);
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const signOut = useMutation({
    mutationFn: (m: Member) => stepUp(() => api(`/members/${m.id}/revoke-sessions`, { method: 'POST', schema: z.object({ revoked: z.number() }) })),
    onSuccess: (r, m) => setNotice(`${m.name} was signed out of ${r.revoked} session${r.revoked === 1 ? '' : 's'}.`),
    onError: (err) => setNotice(errorMessage(err)),
  });

  const columns: Column<Member>[] = [
    {
      key: 'name',
      header: 'Person',
      primary: true,
      render: (m) => (
        <span className="flex flex-col">
          <span className="font-medium">
            {m.name}
            {m.isSelf && <span className="text-muted"> (you)</span>}
          </span>
          <span className="text-xs break-all text-muted">{m.email}</span>
        </span>
      ),
    },
    { key: 'roles', header: 'Roles', render: (m) => m.roles.map((r) => r.name).join(', ') || '—' },
    { key: 'status', header: 'Status', render: (m) => <StatusBadge tone={m.status === 'active' ? 'success' : 'neutral'} label={m.status === 'active' ? 'Active' : 'Disabled'} /> },
    { key: 'mfa', header: 'Two-step', render: (m) => <StatusBadge tone={m.mfaEnabled ? 'success' : 'warning'} label={m.mfaEnabled ? 'On' : 'Off'} /> },
    { key: 'last', header: 'Last sign-in', render: (m) => (m.lastLoginAt ? <span className="tabular whitespace-nowrap">{formatDateTimeIST(m.lastLoginAt)}</span> : '—') },
    {
      key: 'actions',
      header: 'Actions',
      render: (m) =>
        m.isSelf ? (
          <span className="text-xs text-muted">Manage your own access in Account</span>
        ) : (
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(m)} aria-label={`Change access for ${m.name}`}>
              Change access
            </Button>
            <Button size="sm" variant="ghost" onClick={() => signOut.mutate(m)} disabled={signOut.isPending} aria-label={`Sign out ${m.name} everywhere`}>
              Sign out
            </Button>
          </span>
        ),
    },
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <h2 className="text-base font-semibold">People</h2>
        <Button onClick={() => setInviting(true)}>Invite someone</Button>
      </div>
      {notice && (
        <InlineAlert tone="info" className="mx-5 mt-4">
          {notice}
        </InlineAlert>
      )}
      <div className="py-4">
        {members.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : members.isError ? (
          <ErrorState message={errorMessage(members.error)} onRetry={() => void members.refetch()} />
        ) : (
          <DataTable caption="People in this business" hideCaption columns={columns} rows={members.data} rowKey={(m) => m.id} />
        )}
      </div>
      {editing && <EditMemberDialog member={editing} onClose={() => setEditing(null)} onSaved={() => void queryClient.invalidateQueries({ queryKey: key })} />}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </Card>
  );
}

function EditMemberDialog({ member, onClose, onSaved }: { member: Member; onClose: () => void; onSaved: () => void }) {
  const roles = useRoles();
  const stepUp = useStepUp();
  const [roleIds, setRoleIds] = useState(member.roles.map((r) => r.id));
  const [status, setStatus] = useState(member.status);
  const [legalEntityIds, setScope] = useState<string[] | null>(member.legalEntityIds);
  const [warehouseIds, setWarehouses] = useState<string[] | null>(member.warehouseIds);
  const save = useMutation({
    mutationFn: () => stepUp(() => api(`/members/${member.id}`, { method: 'PATCH', body: { version: member.version, roleIds, status, legalEntityIds, warehouseIds }, schema: memberSchema })),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`Change access for ${member.name}`} description={member.email}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
        {roles.data ? <RoleChecklist legend="Roles" roles={roles.data} selected={roleIds} onChange={setRoleIds} /> : <Skeleton className="h-40" />}
        <EntityScopeField value={legalEntityIds} onChange={setScope} />
        <WarehouseScopeField value={warehouseIds} onChange={setWarehouses} entityIds={legalEntityIds} />
        <FormField label="Status" hint="Disabled people can’t open this business. Their account and history stay.">
          {(f) => (
            <Select {...f} value={status} onChange={(e) => setStatus(e.target.value as Member['status'])}>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </Select>
          )}
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || roleIds.length === 0 || (legalEntityIds !== null && legalEntityIds.length === 0) || (warehouseIds !== null && warehouseIds.length === 0)}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roles = useRoles();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const invitationsKey = useTenantQueryKey('invitations');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [legalEntityIds, setScope] = useState<string[] | null>(null);
  const [warehouseIds, setWarehouses] = useState<string[] | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => stepUp(() => api('/invitations', { method: 'POST', body: { email, roleIds, legalEntityIds, warehouseIds }, schema: invitationSchema })),
    onSuccess: (inv) => {
      setSentTo(inv.email);
      setEmail('');
      setRoleIds([]);
      void queryClient.invalidateQueries({ queryKey: invitationsKey });
    },
  });
  const fieldErrors = invite.error instanceof ApiError ? invite.error.fieldErrors() : {};
  const close = () => {
    setSentTo(null);
    invite.reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Invite someone" description="They’ll get an email with a link that works for 7 days.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
        noValidate
        className="flex flex-col gap-5"
      >
        {sentTo && <InlineAlert tone="success">Invitation sent to {sentTo}.</InlineAlert>}
        {invite.isError && <InlineAlert>{errorMessage(invite.error)}</InlineAlert>}
        <FormField label="Email" required error={fieldErrors.email}>
          {(f) => <Input {...f} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </FormField>
        {roles.data ? <RoleChecklist legend="Roles" roles={roles.data} selected={roleIds} onChange={setRoleIds} /> : <Skeleton className="h-40" />}
        <EntityScopeField value={legalEntityIds} onChange={setScope} />
        <WarehouseScopeField value={warehouseIds} onChange={setWarehouses} entityIds={legalEntityIds} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Done
          </Button>
          <Button type="submit" disabled={invite.isPending || !email || roleIds.length === 0}>
            {invite.isPending ? 'Sending…' : 'Send invitation'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InvitationsTab() {
  const key = useTenantQueryKey('invitations');
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const invitations = useQuery({ queryKey: key, queryFn: ({ signal }) => api('/invitations', { schema: listOf(invitationSchema), signal }).then((r) => r.data) });
  const cancel = useMutation({
    mutationFn: (inv: Invitation) => stepUp(() => api(`/invitations/${inv.id}`, { method: 'DELETE' })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const columns: Column<Invitation>[] = [
    { key: 'email', header: 'Email', primary: true, render: (i) => <span className="break-all">{i.email}</span> },
    { key: 'roles', header: 'Roles', render: (i) => i.roles.map((r) => r.name).join(', ') },
    { key: 'by', header: 'Invited by', render: (i) => i.invitedBy },
    { key: 'expires', header: 'Expires', render: (i) => <span className="tabular whitespace-nowrap">{formatDateTimeIST(i.expiresAt)}</span> },
    {
      key: 'actions',
      header: 'Actions',
      render: (i) => (
        <Button size="sm" variant="ghost" onClick={() => cancel.mutate(i)} disabled={cancel.isPending} aria-label={`Cancel invitation for ${i.email}`}>
          Cancel
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <h2 className="px-5 pt-5 text-base font-semibold">Pending invitations</h2>
      {cancel.isError && (
        <InlineAlert className="mx-5 mt-4">{errorMessage(cancel.error)}</InlineAlert>
      )}
      <div className="py-4">
        {invitations.isPending ? (
          <Skeleton className="mx-5 h-32" />
        ) : invitations.isError ? (
          <ErrorState message={errorMessage(invitations.error)} onRetry={() => void invitations.refetch()} />
        ) : (
          <DataTable
            caption="Pending invitations"
            hideCaption
            columns={columns}
            rows={invitations.data}
            rowKey={(i) => i.id}
            empty={<EmptyState title="No pending invitations" description="Invitations you send appear here until they’re accepted or expire." />}
          />
        )}
      </div>
    </Card>
  );
}
