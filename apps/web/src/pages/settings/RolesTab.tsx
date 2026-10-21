import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { roleSchema, type Permission, type Role } from '@bizmgmt/contracts';
import { Button, Card, Checkbox, DataTable, Dialog, ErrorState, FormField, InlineAlert, Input, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useStepUp } from '../../auth/StepUp';
import { useSession } from '../../auth/session';
import { PERMISSION_GROUPS, PERMISSION_LABELS } from '../../app/permissions';
import { api, ApiError } from '../../lib/api';
import { useTenantQueryKey } from '../../lib/queries';
import { useRoles } from './UsersPage';

type Editor = { mode: 'view' | 'edit' | 'create'; role?: Role; seed?: Role };

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

export function RolesTab({ canEdit }: { canEdit: boolean }) {
  const roles = useRoles();
  const [editor, setEditor] = useState<Editor | null>(null);
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('roles');
  const remove = useMutation({
    mutationFn: (role: Role) => stepUp(() => api(`/roles/${role.id}`, { method: 'DELETE' })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const columns: Column<Role>[] = [
    {
      key: 'name',
      header: 'Role',
      primary: true,
      render: (r) => (
        <span className="flex flex-col">
          <span className="font-medium">{r.name}</span>
          {r.description && <span className="text-xs text-muted">{r.description}</span>}
        </span>
      ),
    },
    { key: 'type', header: 'Type', render: (r) => <StatusBadge tone={r.system ? 'info' : 'neutral'} label={r.system ? 'Built-in' : 'Custom'} /> },
    { key: 'people', header: 'People', align: 'end', render: (r) => <span className="tabular">{r.memberCount}</span> },
    { key: 'perms', header: 'Permissions', align: 'end', render: (r) => <span className="tabular">{r.permissions.length}</span> },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEditor({ mode: canEdit && !r.system ? 'edit' : 'view', role: r })} aria-label={`${canEdit && !r.system ? 'Edit' : 'View'} ${r.name}`}>
            {canEdit && !r.system ? 'Edit' : 'View'}
          </Button>
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => setEditor({ mode: 'create', seed: r })} aria-label={`Copy ${r.name}`}>
              Copy
            </Button>
          )}
          {canEdit && !r.system && (
            <Button size="sm" variant="ghost" onClick={() => remove.mutate(r)} disabled={remove.isPending} aria-label={`Remove ${r.name}`}>
              Remove
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="text-base font-semibold">Roles</h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted">Built-in roles can’t be changed. Copy one to make a custom role.</p>
        </div>
        {canEdit && <Button onClick={() => setEditor({ mode: 'create' })}>New role</Button>}
      </div>
      {remove.isError && <InlineAlert className="mx-5 mt-4">{errorMessage(remove.error)}</InlineAlert>}
      <div className="py-4">
        {roles.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : roles.isError ? (
          <ErrorState message={errorMessage(roles.error)} onRetry={() => void roles.refetch()} />
        ) : (
          <DataTable caption="Roles" hideCaption columns={columns} rows={roles.data} rowKey={(r) => r.id} />
        )}
      </div>
      {editor && <RoleDialog editor={editor} onClose={() => setEditor(null)} />}
    </Card>
  );
}

function RoleDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { can } = useSession();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('roles');
  const source = editor.role ?? editor.seed;
  const readOnly = editor.mode === 'view';
  const [name, setName] = useState(editor.mode === 'create' ? (source ? `${source.name} (copy)` : '') : (source?.name ?? ''));
  const [description, setDescription] = useState(source?.description ?? '');
  const [permissions, setPermissions] = useState<Permission[]>(source?.permissions ?? []);

  const save = useMutation({
    mutationFn: () =>
      stepUp(() =>
        editor.mode === 'edit' && editor.role
          ? api(`/roles/${editor.role.id}`, { method: 'PATCH', body: { version: editor.role.version, name, description, permissions }, schema: roleSchema })
          : api('/roles', { method: 'POST', body: { name, description, permissions }, schema: roleSchema }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      onClose();
    },
  });

  const toggle = (p: Permission, on: boolean) => setPermissions((list) => (on ? [...list, p] : list.filter((x) => x !== p)));
  const title = editor.mode === 'create' ? 'New role' : readOnly ? (source?.name ?? 'Role') : `Edit ${source?.name ?? 'role'}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={readOnly ? source?.description : 'You can only include permissions you have yourself.'} className="max-w-2xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        noValidate
        className="flex flex-col gap-5"
      >
        {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
        {!readOnly && (
          <>
            <FormField label="Name" required>
              {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}
            </FormField>
            <FormField label="Description">
              {(f) => <Input {...f} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />}
            </FormField>
          </>
        )}
        {PERMISSION_GROUPS.map((group) => (
          <fieldset key={group.label} className="flex flex-col gap-2">
            <legend className="mb-1 text-[0.8125rem] font-semibold">{group.label}</legend>
            {group.permissions.map((p) =>
              readOnly ? (
                <p key={p} className="flex items-start gap-2 text-sm">
                  <StatusBadge tone={permissions.includes(p) ? 'success' : 'neutral'} label={permissions.includes(p) ? 'Yes' : 'No'} />
                  <span className={permissions.includes(p) ? '' : 'text-muted'}>{PERMISSION_LABELS[p]}</span>
                </p>
              ) : (
                <Checkbox key={p} label={PERMISSION_LABELS[p]} checked={permissions.includes(p)} disabled={!can(p) && !permissions.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />
              ),
            )}
          </fieldset>
        ))}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button type="submit" disabled={save.isPending || name.trim().length < 2}>
              {save.isPending ? 'Saving…' : 'Save role'}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
