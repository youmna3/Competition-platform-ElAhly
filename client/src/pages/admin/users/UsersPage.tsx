import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ROLE_LABELS,
  STATUS_LABELS,
  type AccountStatus,
  type ManagedUser,
  type TemporaryPasswordResponse,
  type UserRole,
  type UsersListResponse,
} from '@judging/shared';
import { api } from '../../../api/client';
import { ME_QUERY_KEY, useAuth } from '../../../auth/AuthContext';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { useToast } from '../../../components/Toast';
import { Alert, Badge, Button, Card, SelectField } from '../../../components/ui';
import {
  ConfirmDialog,
  TemporaryPasswordDialog,
  UserFormDialog,
  type UserFormValues,
} from './dialogs';

type DialogState =
  | { kind: 'create' }
  | { kind: 'edit'; user: ManagedUser }
  | { kind: 'disable'; user: ManagedUser }
  | { kind: 'reactivate'; user: ManagedUser }
  | { kind: 'reset'; user: ManagedUser }
  | { kind: 'password'; title: string; user: ManagedUser; password: string }
  | null;

const PAGE_SIZE = 25;

function formatLastLogin(value: string | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function StatusBadges({ user }: { user: ManagedUser }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone={user.status === 'active' ? 'green' : 'gray'}>{STATUS_LABELS[user.status]}</Badge>
      {user.mustChangePassword && user.status === 'active' && (
        <Badge tone="gold">Must change password</Badge>
      )}
      {user.isLocked && <Badge tone="red">Locked</Badge>}
    </div>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'' | UserRole>('');
  const [status, setStatus] = useState<'' | AccountStatus>('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<DialogState>(null);
  const debouncedSearch = useDebounced(search.trim());
  // Changing a filter always goes back to the first page.
  const [lastFilters, setLastFilters] = useState('');
  const filterKey = `${debouncedSearch}|${role}|${status}`;
  if (filterKey !== lastFilters) {
    setLastFilters(filterKey);
    if (page !== 1) setPage(1);
  }

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (role) params.set('role', role);
  if (status) params.set('status', status);

  const query = useQuery({
    queryKey: ['admin', 'users', params.toString()],
    queryFn: () => api<UsersListResponse>(`/api/admin/users?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  const activeAdmins = query.data?.activeAdmins ?? 0;
  const isLastAdmin = (u: ManagedUser) =>
    u.role === 'admin' && u.status === 'active' && activeAdmins <= 1;

  async function refresh(affectsMe = false) {
    await queryClient.invalidateQueries({ queryKey: ['admin'] });
    if (affectsMe) await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }

  async function create(values: UserFormValues) {
    const result = await api<TemporaryPasswordResponse>('/api/admin/users', {
      method: 'POST',
      body: values,
    });
    await refresh();
    setDialog({
      kind: 'password',
      title: 'Account created',
      user: result.user,
      password: result.temporaryPassword,
    });
    toast(`Account created for ${result.user.fullName}.`);
  }

  async function edit(user: ManagedUser, values: UserFormValues) {
    const changes: Partial<UserFormValues> = {};
    if (values.fullName !== user.fullName) changes.fullName = values.fullName;
    if (values.email.toLowerCase() !== user.email) changes.email = values.email;
    if (values.role !== user.role) changes.role = values.role;
    if (Object.keys(changes).length === 0) {
      setDialog(null);
      return;
    }
    const { user: updated } = await api<{ user: ManagedUser }>(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: changes,
    });
    setDialog(null);
    await refresh(user.id === me?.id);
    toast(
      changes.role
        ? `${updated.fullName} is now ${changes.role === 'admin' ? 'an administrator' : 'a judge'}.`
        : `Saved changes to ${updated.fullName}.`,
    );
  }

  async function setAccountStatus(user: ManagedUser, next: AccountStatus) {
    const { user: updated } = await api<{ user: ManagedUser }>(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: { status: next },
    });
    setDialog(null);
    await refresh();
    toast(
      next === 'disabled'
        ? `${updated.fullName} was disabled and signed out.`
        : `${updated.fullName} was reactivated.`,
    );
  }

  async function resetPassword(user: ManagedUser) {
    const result = await api<TemporaryPasswordResponse>(
      `/api/admin/users/${user.id}/reset-password`,
      { method: 'POST' },
    );
    await refresh();
    setDialog({
      kind: 'password',
      title: 'Password reset',
      user: result.user,
      password: result.temporaryPassword,
    });
    toast(`Password reset for ${result.user.fullName}. They were signed out everywhere.`);
  }

  function Actions({ user }: { user: ManagedUser }) {
    const self = user.id === me?.id;
    return (
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="secondary"
          className="!px-3 !py-1.5 text-xs"
          onClick={() => setDialog({ kind: 'edit', user })}
          aria-label={`Edit ${user.fullName}`}
        >
          Edit
        </Button>
        {!self && (
          <Button
            variant="secondary"
            className="!px-3 !py-1.5 text-xs"
            onClick={() => setDialog({ kind: 'reset', user })}
            aria-label={`Reset password for ${user.fullName}`}
          >
            Reset password
          </Button>
        )}
        {user.status === 'active' && !self && (
          <Button
            variant="ghost"
            className="!px-3 !py-1.5 text-xs !text-ahly-red-dark"
            onClick={() => setDialog({ kind: 'disable', user })}
            disabled={isLastAdmin(user)}
            title={
              isLastAdmin(user) ? 'The last active administrator cannot be disabled' : undefined
            }
            aria-label={`Disable ${user.fullName}`}
          >
            Disable
          </Button>
        )}
        {user.status === 'disabled' && (
          <Button
            variant="ghost"
            className="!px-3 !py-1.5 text-xs !text-emerald-700"
            onClick={() => setDialog({ kind: 'reactivate', user })}
            aria-label={`Reactivate ${user.fullName}`}
          >
            Reactivate
          </Button>
        )}
      </div>
    );
  }

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = Boolean(debouncedSearch || role || status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ahly-red">Administrator</p>
          <h1 className="text-2xl font-bold sm:text-3xl">Users</h1>
          <p className="mt-1 text-sm text-black/60">
            Administrators and judges who can sign in. There is no public sign-up.
          </p>
        </div>
        <Button onClick={() => setDialog({ kind: 'create' })}>+ Add user</Button>
      </div>

      <Card className="grid gap-3 !p-4 sm:grid-cols-[1fr_180px_180px]">
        <div className="space-y-1.5">
          <label htmlFor="user-search" className="block text-sm font-medium">
            Search
          </label>
          <input
            id="user-search"
            type="search"
            placeholder="Name or e-mail"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
            className="block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
          />
        </div>
        <SelectField
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as '' | UserRole)}
        >
          <option value="">All roles</option>
          <option value="admin">Administrators</option>
          <option value="judge">Judges</option>
        </SelectField>
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | AccountStatus)}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </SelectField>
      </Card>

      {query.isPending ? (
        <FullPageSpinner label="Loading users…" />
      ) : query.isError ? (
        <Alert tone="error" title="Could not load users">
          {query.error.message}
        </Alert>
      ) : data && data.users.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-lg font-semibold">
            {filtered ? 'No users match these filters' : 'No users yet'}
          </p>
          <p className="mt-1 text-sm text-black/60">
            {filtered
              ? 'Try a different search or clear the filters.'
              : 'Add the first judge with “Add user”.'}
          </p>
        </Card>
      ) : data ? (
        <>
          <p className="text-sm text-black/60" aria-live="polite">
            {data.total} {data.total === 1 ? 'account' : 'accounts'}
            {filtered ? ' match' : ''}
          </p>

          {/* Desktop table */}
          <Card className="hidden !p-0 md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-black/5 text-xs uppercase tracking-wide text-black/50">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Role
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Teams
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    Last sign-in
                  </th>
                  <th scope="col" className="px-5 py-3 font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {data.users.map((u) => (
                  <tr
                    key={u.id}
                    className={u.status === 'disabled' ? 'bg-black/[0.02] text-black/55' : ''}
                  >
                    <td className="px-5 py-3">
                      <p className="font-semibold text-ink">
                        {u.fullName}{' '}
                        {u.id === me?.id && (
                          <span className="text-xs font-normal text-black/50">(you)</span>
                        )}
                      </p>
                      <p className="text-black/60 break-all">{u.email}</p>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={u.role === 'admin' ? 'red' : 'blue'}>
                        {ROLE_LABELS[u.role]}
                      </Badge>
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadges user={u} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {u.role === 'judge' || u.assignedTeams > 0 ? u.assignedTeams : '—'}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {formatLastLogin(u.lastLoginAt)}
                    </td>
                    <td className="px-5 py-3">
                      <Actions user={u} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Phone and tablet cards */}
          <ul className="space-y-3 md:hidden">
            {data.users.map((u) => (
              <li key={u.id}>
                <Card className="space-y-3 !p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {u.fullName}{' '}
                        {u.id === me?.id && (
                          <span className="text-xs font-normal text-black/50">(you)</span>
                        )}
                      </p>
                      <p className="text-sm text-black/60 break-all">{u.email}</p>
                    </div>
                    <Badge tone={u.role === 'admin' ? 'red' : 'blue'}>{ROLE_LABELS[u.role]}</Badge>
                  </div>
                  <StatusBadges user={u} />
                  <p className="text-xs text-black/55">
                    {(u.role === 'judge' || u.assignedTeams > 0) && (
                      <>Assigned teams: {u.assignedTeams} · </>
                    )}
                    Last sign-in: {formatLastLogin(u.lastLoginAt)}
                  </p>
                  <Actions user={u} />
                </Card>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Previous
              </Button>
              <span className="text-sm text-black/60">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </Button>
            </div>
          )}
        </>
      ) : null}

      {dialog?.kind === 'create' && (
        <UserFormDialog mode="create" onSubmit={create} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'edit' && (
        <UserFormDialog
          mode="edit"
          initial={dialog.user}
          isSelf={dialog.user.id === me?.id}
          isLastAdmin={isLastAdmin(dialog.user)}
          onSubmit={(values) => edit(dialog.user, values)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'disable' && (
        <ConfirmDialog
          title={`Disable ${dialog.user.fullName}?`}
          message="They will be signed out immediately and won't be able to sign in until the account is reactivated. Their evaluations are kept."
          confirmLabel="Disable account"
          danger
          onConfirm={() => setAccountStatus(dialog.user, 'disabled')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'reactivate' && (
        <ConfirmDialog
          title={`Reactivate ${dialog.user.fullName}?`}
          message="They will be able to sign in again with their current password."
          confirmLabel="Reactivate account"
          onConfirm={() => setAccountStatus(dialog.user, 'active')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog
          title={`Reset the password for ${dialog.user.fullName}?`}
          message="Their current password stops working, they are signed out on every device, and they must choose a new password at next sign-in."
          confirmLabel="Reset password"
          danger
          onConfirm={() => resetPassword(dialog.user)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'password' && (
        <TemporaryPasswordDialog
          title={dialog.title}
          user={dialog.user}
          password={dialog.password}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
