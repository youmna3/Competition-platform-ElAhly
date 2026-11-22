import { useState, type FormEvent, type ReactNode } from 'react';
import type { ManagedUser, UserRole } from '@judging/shared';
import { ApiError } from '../../../api/client';
import { Modal } from '../../../components/Modal';
import { Alert, Button, SelectField, TextField } from '../../../components/ui';

export interface UserFormValues {
  fullName: string;
  email: string;
  role: UserRole;
}

function fieldErrors(error: unknown): Record<string, string> {
  if (error instanceof ApiError && error.details && typeof error.details === 'object') {
    const fields = (error.details as { fields?: Record<string, string> }).fields;
    if (fields) return fields;
  }
  return {};
}

/** Create or edit an account's name, e-mail and role. */
export function UserFormDialog({
  mode,
  initial,
  isSelf = false,
  isLastAdmin = false,
  onSubmit,
  onClose,
}: {
  mode: 'create' | 'edit';
  initial?: ManagedUser;
  isSelf?: boolean;
  isLastAdmin?: boolean;
  onSubmit: (values: UserFormValues) => Promise<void>;
  onClose: () => void;
}) {
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [role, setRole] = useState<UserRole>(initial?.role ?? 'judge');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const fields = fieldErrors(error);
  const demotingSelf = isSelf && initial?.role === 'admin' && role === 'judge';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ fullName: fullName.trim(), email: email.trim(), role });
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  }

  return (
    <Modal
      title={mode === 'create' ? 'Add a user' : `Edit ${initial?.fullName}`}
      description={
        mode === 'create'
          ? 'A strong temporary password is created and shown once. The person must change it at first sign-in.'
          : 'Changes take effect immediately.'
      }
      onClose={onClose}
      canClose={!saving}
    >
      <form id="user-form" className="space-y-4" onSubmit={submit} noValidate>
        {error instanceof Error && !Object.keys(fields).length ? (
          <Alert tone="error">{error.message}</Alert>
        ) : null}
        <TextField
          label="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="off"
          maxLength={200}
          required
          error={fields.fullName}
        />
        <TextField
          label="E-mail"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          maxLength={254}
          required
          error={fields.email}
          hint="Used to sign in. Each e-mail can have only one account."
        />
        <SelectField
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          disabled={isLastAdmin && initial?.role === 'admin'}
        >
          <option value="judge">Judge — scores assigned teams</option>
          <option value="admin">Administrator — manages the competition</option>
        </SelectField>
        {isLastAdmin && initial?.role === 'admin' && (
          <p className="text-xs text-black/60">
            This is the last active administrator, so the role can&apos;t be changed. Make another
            account an administrator first.
          </p>
        )}
        {demotingSelf && (
          <Alert tone="warning">
            You are removing your own administrator access. You will be taken to the judge area.
          </Alert>
        )}
      </form>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="user-form"
          disabled={saving || !fullName.trim() || !email.trim()}
        >
          {saving ? 'Saving…' : mode === 'create' ? 'Create account' : 'Save changes'}
        </Button>
      </div>
    </Modal>
  );
}

/** Confirmation for sensitive actions. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }
  return (
    <Modal title={title} description={message} onClose={onClose} canClose={!busy} size="sm">
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={danger ? 'danger' : 'primary'}
          onClick={confirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

/** Shows a temporary password exactly once, with copy and an acknowledgement. */
export function TemporaryPasswordDialog({
  title,
  user,
  password,
  onClose,
}: {
  title: string;
  user: ManagedUser;
  password: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      title={title}
      description={
        <>
          Give this temporary password to <strong>{user.fullName}</strong> privately (in person or
          by phone). It is shown <strong>only once</strong> and cannot be viewed again. They must
          choose their own password at first sign-in.
        </>
      }
      onClose={onClose}
      canClose={saved}
    >
      <dl className="space-y-3 rounded-2xl bg-surface p-4">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-black/50">E-mail</dt>
          <dd className="font-medium break-all">{user.email}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-black/50">
            Temporary password
          </dt>
          <dd className="mt-1 flex flex-wrap items-center gap-3">
            <code
              data-testid="temporary-password"
              className="rounded-lg border border-black/10 bg-white px-3 py-2 font-mono text-lg tracking-wide select-all"
            >
              {password}
            </code>
            <Button type="button" variant="secondary" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy'}
            </Button>
          </dd>
        </div>
      </dl>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-ahly-red"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        <span>I have copied or written down this password.</span>
      </label>
      <div className="flex justify-end pt-2">
        <Button type="button" onClick={onClose} disabled={!saved}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
