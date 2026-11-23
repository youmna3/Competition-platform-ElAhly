import { useCompetition } from '../../../components/CompetitionNotice';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  COMPETITION_LABELS,
  RUBRIC_ERRORS,
  contentOf,
  isPointsRubric,
  maximumScore,
  totalWeight,
  validateRubric,
  type AdminRubricResponse,
  type PublishRubricResponse,
  type RubricContent,
  type RubricVersion,
} from '@judging/shared';
import { ApiError, api } from '../../../api/client';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { Modal } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import { Alert, Badge, Button, Card, PageHeader } from '../../../components/ui';
import { ConfirmDialog } from '../users/dialogs';
import { RubricView } from '../../rubric/RubricView';
import { RubricEditor } from './RubricEditor';
import { focusPath, issueMap, toContent, toEdit, type EditRubric } from './model';
import { useUnsavedChangesGuard } from '../../../hooks/useUnsavedChangesGuard';

const QUERY_KEY = ['admin', 'rubric'] as const;
const formatDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';
const snapshot = (c: RubricContent) => JSON.stringify(c);

type Dialog =
  { kind: 'preview' } | { kind: 'publish' } | { kind: 'discard' } | { kind: 'official' };

export function RubricManagementPage() {
  const lifecycle = useCompetition();
  const rubricLocked = !!lifecycle.data && lifecycle.data.state !== 'preparation';
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<AdminRubricResponse>('/api/admin/rubric'),
  });
  const data = query.data;
  const draft = data?.draft ?? null;

  const [edit, setEdit] = useState<EditRubric | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const content = useMemo(() => (edit ? toContent(edit) : null), [edit]);
  const validation = useMemo(() => (content ? validateRubric(content) : null), [content]);
  const dirty = Boolean(content && snapshot(content) !== baseline);
  useUnsavedChangesGuard(dirty, 'You have unsaved rubric changes. Leave without saving?');

  function load(version: RubricVersion) {
    const next = toEdit(contentOf(version));
    setEdit(next);
    setBaseline(snapshot(toContent(next)));
    setRevision(version.revision);
    setLoadedFor(`${version.id}:${version.revision}`);
    setConflict(false);
  }

  // Load the draft into the editor whenever a different draft or revision
  // arrives, but never over unsaved work (a later save then reports the conflict).
  const draftKey = draft ? `${draft.id}:${draft.revision}` : null;
  if (draftKey !== loadedFor && !dirty) {
    if (draft) load(draft);
    else {
      setEdit(null);
      setLoadedFor(null);
    }
  }

  function handleError(e: unknown) {
    if (e instanceof ApiError && e.code === RUBRIC_ERRORS.REVISION_CONFLICT) setConflict(true);
    else if (e instanceof ApiError && e.code === RUBRIC_ERRORS.NO_DRAFT) {
      setError(e.message);
      void query.refetch();
    } else setError(e instanceof Error ? e.message : 'Something went wrong.');
  }

  async function startDraft(sourceVersionId?: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<AdminRubricResponse>('/api/admin/rubric/draft', {
        method: 'POST',
        body: sourceVersionId ? { sourceVersionId } : {},
      });
      queryClient.setQueryData(QUERY_KEY, result);
      if (result.draft) load(result.draft);
      toast(result.published ? 'Draft created from the published rubric.' : 'Draft created.');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  /** Fills the draft with the official 2026 points rubric (never publishes). */
  async function loadOfficial(replaceDraft: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<AdminRubricResponse>('/api/admin/rubric/draft/official', {
        method: 'POST',
        body: { replaceDraft },
      });
      queryClient.setQueryData(QUERY_KEY, result);
      if (result.draft) load(result.draft);
      setDialog(null);
      toast('Official 2026 rubric loaded into the draft. Review it, then publish when ready.');
    } catch (e) {
      setDialog(null);
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  /** Saves the editor's content; returns the new revision. */
  async function save(): Promise<number> {
    const result = await api<{ draft: RubricVersion }>('/api/admin/rubric/draft', {
      method: 'PUT',
      body: { revision, content: content! },
    });
    load(result.draft);
    queryClient.setQueryData<AdminRubricResponse>(QUERY_KEY, (old) =>
      old ? { ...old, draft: result.draft } : old,
    );
    return result.draft.revision;
  }

  async function saveClicked() {
    setBusy(true);
    setError(null);
    try {
      await save();
      toast('Draft saved.');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function reloadLatest() {
    const result = await query.refetch();
    if (result.data?.draft) load(result.data.draft);
    else {
      setEdit(null);
      setConflict(false);
    }
  }

  if (query.isPending) return <FullPageSpinner label="Loading the rubric…" />;
  if (query.isError) {
    return (
      <Alert tone="error" title="Could not load the rubric">
        {query.error.message}
      </Alert>
    );
  }
  const published = data!.published;
  const evaluations = data!.evaluations;
  const mixed = evaluations.submittedVersions.length > 1;

  const history = (
    <RubricHistory
      versions={data!.versions ?? [published, draft].filter((v): v is RubricVersion => v != null)}
      activeId={published?.id}
      canRestore={!rubricLocked && !draft && !busy}
      onRestore={(id) => void startDraft(id)}
    />
  );
  const lockedNo = lifecycle.data?.lockedRubricVersionNo ?? null;
  const officialButton = (
    <Button
      onClick={() => (draft ? setDialog({ kind: 'official' }) : void loadOfficial(false))}
      disabled={busy || rubricLocked}
    >
      Load Official 2026 Rubric
    </Button>
  );
  const header = (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Administrator"
        title="Rubric Management"
        description="Published versions never change. Edits go into a draft, and judges keep using the published version until you publish the draft."
        actions={
          published && (
            <Link to="/rubric" className="secondary-link">
              View as judges see it →
            </Link>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="rubric-status space-y-2 border-emerald-600/25">
          <p className="eyebrow !text-emerald-700">Used for judging</p>
          {published ? (
            <>
              <p className="text-xl font-bold">
                Version {published.versionNo}{' '}
                <Badge tone="green">{lockedNo != null ? 'Locked' : 'Published'}</Badge>
              </p>
              <p className="truncate text-sm font-medium text-ink">{published.title}</p>
              <p className="text-sm text-muted">
                {isPointsRubric(published) ? 'Numeric points' : 'Star scoring'} · out of{' '}
                {maximumScore(published.sections)} · {evaluations.onPublished} evaluation
                {evaluations.onPublished === 1 ? '' : 's'}
              </p>
              {lifecycle.data && (
                <p className="text-xs text-muted">
                  Competition: {COMPETITION_LABELS[lifecycle.data.state]}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">No published rubric yet. Judges can’t score.</p>
          )}
        </Card>
        <Card className="rubric-status space-y-2 border-ahly-gold/50">
          <p className="eyebrow !text-amber-800">Draft for review</p>
          {draft ? (
            <>
              <p className="text-xl font-bold">
                Version {draft.versionNo} <Badge tone="gold">Not published</Badge>
              </p>
              <p className="truncate text-sm font-medium text-ink">
                {draft.title || 'Untitled draft'}
              </p>
              <p className="text-sm text-muted">
                {isPointsRubric(draft) ? 'Numeric points' : 'Star scoring'} · saved{' '}
                {formatDate(draft.updatedAt)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">
              No draft. Edit the rubric or load the official rubric to create one.
            </p>
          )}
        </Card>
        <Card className="rubric-status space-y-3 border-ischool-blue/30 bg-ischool-blue-soft/40">
          <p className="eyebrow">Official 2026 rubric</p>
          <p className="text-sm text-ink">
            4 sections · 12 criteria · numeric points totalling <strong>100</strong> (A 30, B 25, C
            25, D 20), from the official judging criteria document.
          </p>
          {officialButton}
          <p className="text-xs text-muted">
            {rubricLocked
              ? 'The rubric is locked while the competition is not in Preparation.'
              : 'Saved as a draft for your review. It is never published automatically.'}
          </p>
        </Card>
      </div>
    </div>
  );

  const mixedWarning = mixed && (
    <Alert tone="warning" title="Submitted evaluations use different rubric versions">
      Versions {evaluations.submittedVersions.join(', ')} have submitted evaluations. Their scores
      are kept exactly as submitted. Results will show which version each evaluation used, and these
      versions must not be compared as if they were the same.
    </Alert>
  );

  // ---- No draft: not configured, or published and nothing pending ----
  if (!draft || !edit || !content || !validation) {
    return (
      <div className="space-y-6">
        {header}
        {error && <Alert tone="error">{error}</Alert>}
        {mixedWarning}
        {!published ? (
          <Card className="py-12 text-center">
            <p className="text-lg font-semibold">The rubric is not configured yet</p>
            <p className="mx-auto mt-1 max-w-lg text-sm text-black/60">
              Start with four Actual sections, each with two criteria rated 1 to 5 stars. Add Actual
              or Bonus sections in the draft. You name them, describe them and set each section’s
              share of the score out of 100. Judges can’t score until you publish it.
            </p>
            <Button
              className="mt-5"
              onClick={() => void startDraft()}
              disabled={busy || rubricLocked}
            >
              {busy ? 'Starting…' : 'Start building the rubric'}
            </Button>
          </Card>
        ) : (
          <>
            <Card className="flex flex-wrap items-center justify-between gap-4">
              <div className="text-sm">
                <p className="font-semibold">
                  Version {published.versionNo} is active for NEW evaluations.
                </p>
                <p className="text-black/60">
                  Published {formatDate(published.publishedAt)}
                  {published.publishedByEmail && ` by ${published.publishedByEmail}`} ·{' '}
                  {evaluations.onPublished} evaluation{evaluations.onPublished === 1 ? '' : 's'} use
                  it
                </p>
              </div>
              <Button onClick={() => void startDraft()} disabled={busy || rubricLocked}>
                {busy ? 'Opening…' : 'Edit rubric'}
              </Button>
            </Card>
            <p className="text-sm text-muted">
              Editing creates a draft copy. Judges keep using version {published.versionNo} until
              you publish the draft.
            </p>
            <RubricView rubric={contentOf(published)} />
          </>
        )}
        {history}
      </div>
    );
  }

  // ---- Editing a draft ----
  const saveErrors = issueMap(validation.save);
  const weightTotal = isPointsRubric(content)
    ? content.sections.reduce(
        (n, sec) => n + sec.criteria.reduce((m, c) => m + (c.maxPoints ?? 0), 0),
        0,
      )
    : totalWeight(content.sections);
  const allIssues = [...validation.save, ...validation.publish];

  return (
    <div className="space-y-6 pb-24">
      {header}
      {mixedWarning}
      {conflict && (
        <Alert tone="error" title="This draft was changed somewhere else">
          <p>
            Someone saved the draft in another window or as another administrator after you opened
            it. Reload to get the latest draft. Your unsaved changes here will be lost.
          </p>
          <Button variant="secondary" className="mt-2 !py-1.5" onClick={reloadLatest}>
            Reload latest draft
          </Button>
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {published && (
        <Alert tone="info">
          Judges are still using version {published.versionNo}. Your changes reach them only when
          you publish this draft.
        </Alert>
      )}

      <Card className={`space-y-3 ${allIssues.length ? '' : 'border-emerald-600/20'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            {allIssues.length === 0
              ? 'Ready to publish'
              : `${allIssues.length} thing${allIssues.length === 1 ? '' : 's'} to fix before publishing`}
          </h2>
          <span className="text-sm text-black/60">
            {isPointsRubric(content) ? 'Total points' : 'Total weight'}:{' '}
            <strong className={weightTotal === 100 ? 'text-emerald-700' : 'text-ahly-red-dark'}>
              {weightTotal}
              {isPointsRubric(content) ? '' : '%'} / 100{isPointsRubric(content) ? '' : '%'}
            </strong>
          </span>
        </div>
        {allIssues.length > 0 && (
          <ul className="space-y-1 text-sm">
            {validation.save.map((issue, i) => (
              <li key={`s${i}`}>
                <button
                  type="button"
                  className="text-left text-ahly-red-dark hover:underline"
                  onClick={() => focusPath(issue.path)}
                >
                  ● {issue.message}
                </button>
              </li>
            ))}
            {validation.publish.map((issue, i) => (
              <li key={`p${i}`}>
                <button
                  type="button"
                  className="text-left text-amber-900 hover:underline"
                  onClick={() => focusPath(issue.path)}
                >
                  ○ {issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
        {validation.save.length > 0 && (
          <p className="text-xs text-muted">● must be fixed before the draft can be saved.</p>
        )}
      </Card>

      <fieldset disabled={rubricLocked}>
        <RubricEditor value={edit} onChange={setEdit} errors={saveErrors} content={content} />
      </fieldset>
      {history}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <p className="text-sm" role="status">
            {dirty ? (
              <span className="font-semibold text-ahly-red-dark">● Unsaved changes</span>
            ) : (
              <span className="text-muted">All changes saved · {formatDate(draft.updatedAt)}</span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              className="!py-2"
              onClick={() => setDialog({ kind: 'discard' })}
              disabled={busy || rubricLocked}
            >
              Discard draft
            </Button>
            <Button
              variant="secondary"
              className="!py-2"
              onClick={() => setDialog({ kind: 'preview' })}
            >
              Preview
            </Button>
            <Button
              variant="secondary"
              className="!py-2"
              onClick={saveClicked}
              disabled={busy || rubricLocked || !dirty || validation.save.length > 0 || conflict}
            >
              {busy ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              className="!py-2"
              onClick={() => setDialog({ kind: 'publish' })}
              disabled={busy || rubricLocked || allIssues.length > 0 || conflict}
              title={allIssues.length ? 'Fix the listed problems to publish' : undefined}
            >
              Publish…
            </Button>
          </div>
        </div>
      </div>

      {dialog?.kind === 'preview' && (
        <Modal
          title="Preview"
          description="This is how judges will see the rubric."
          onClose={() => setDialog(null)}
          size="lg"
          focusPanel
          footer={
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Close preview
            </Button>
          }
        >
          <Alert tone="warning">
            Preview of the draft. It isn’t published{dirty ? ' or saved' : ''}.
          </Alert>
          <RubricView rubric={content} practice />
        </Modal>
      )}

      {dialog?.kind === 'publish' && (
        <PublishDialog
          content={content}
          versionNo={draft.versionNo}
          published={published}
          evaluations={evaluations}
          dirty={dirty}
          onClose={() => setDialog(null)}
          onPublish={async (confirmExistingEvaluations) => {
            const rev = dirty ? await save() : revision;
            const result = await api<PublishRubricResponse>('/api/admin/rubric/draft/publish', {
              method: 'POST',
              body: { revision: rev, confirmExistingEvaluations },
            });
            setDialog(null);
            setEdit(null);
            setLoadedFor(null);
            setBaseline('');
            await queryClient.invalidateQueries({ queryKey: ['admin'] });
            await queryClient.invalidateQueries({ queryKey: ['judge', 'rubric'] });
            toast(`Rubric version ${result.versionNo} is published.`);
          }}
          onError={handleError}
        />
      )}

      {dialog?.kind === 'official' && (
        <ConfirmDialog
          title="Replace the draft with the official 2026 rubric?"
          message={`Draft version ${draft.versionNo} will be filled with the 4 sections and 12 criteria of the official rubric (numeric points, 100 in total).${dirty ? ' Your unsaved changes in the editor will be lost.' : ''} Nothing is published, and published versions and evaluations are not changed.`}
          confirmLabel="Load official rubric"
          onClose={() => setDialog(null)}
          onConfirm={() => loadOfficial(true)}
        />
      )}

      {dialog?.kind === 'discard' && (
        <ConfirmDialog
          title="Discard this draft?"
          message={
            published
              ? `All changes in draft version ${draft.versionNo} are deleted. Judges keep using version ${published.versionNo}.`
              : 'The whole draft is deleted and the rubric goes back to Not configured.'
          }
          confirmLabel="Discard draft"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              const result = await api<AdminRubricResponse>('/api/admin/rubric/draft', {
                method: 'DELETE',
                body: { revision },
              });
              setDialog(null);
              setEdit(null);
              setLoadedFor(null);
              setBaseline('');
              queryClient.setQueryData(QUERY_KEY, result);
              toast('Draft discarded.');
            } catch (e) {
              if (e instanceof ApiError && e.code === RUBRIC_ERRORS.REVISION_CONFLICT) {
                setDialog(null);
                setConflict(true);
                return;
              }
              throw e;
            }
          }}
        />
      )}
    </div>
  );
}

function PublishDialog({
  content,
  versionNo,
  published,
  evaluations,
  dirty,
  onClose,
  onPublish,
  onError,
}: {
  content: RubricContent;
  versionNo: number;
  published: RubricVersion | null;
  evaluations: AdminRubricResponse['evaluations'];
  dirty: boolean;
  onClose: () => void;
  onPublish: (confirmExistingEvaluations: boolean) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const needsAck = Boolean(published && evaluations.onPublished > 0);
  const weightChanges = published
    ? content.sections
        .map((s, i) => ({
          title: s.title,
          from: published.sections[i]?.weightPercent,
          to: s.weightPercent,
        }))
        .filter((c) => c.from !== c.to)
    : [];

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onPublish(needsAck && acknowledged);
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === RUBRIC_ERRORS.REVISION_CONFLICT || e.code === RUBRIC_ERRORS.NO_DRAFT)
      ) {
        onClose();
        onError(e);
        return;
      }
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={published ? `Publish version ${versionNo}?` : 'Publish the rubric?'}
      description={
        published
          ? `Judges switch from version ${published.versionNo} to this version for new evaluations.`
          : 'Judges can see the rubric as soon as it is published.'
      }
      onClose={onClose}
      canClose={!busy}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <table className="w-full text-sm">
        <caption className="sr-only">Section weights</caption>
        <tbody className="divide-y divide-black/5">
          {content.sections.map((s, i) => (
            <tr key={i}>
              <th scope="row" className="py-1.5 text-left font-medium">
                {i + 1}. {s.title}
              </th>
              <td className="py-1.5 text-right font-semibold tabular-nums">
                {s.type === 'bonus' ? `Bonus +${s.maxBonusPoints}` : `${s.weightPercent}%`}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-1.5 text-left font-bold">
              Total
            </th>
            <td className="py-1.5 text-right font-bold text-emerald-700 tabular-nums">
              {totalWeight(content.sections)}%
            </td>
          </tr>
        </tbody>
      </table>
      <ul className="list-disc space-y-1 pl-5 text-sm text-black/70">
        {dirty && <li>Your unsaved changes are saved first.</li>}
        <li>A published version can’t be changed. Later edits go into a new draft.</li>
        {published && (
          <li>
            Version {published.versionNo} is kept, read-only, with every evaluation that used it.
          </li>
        )}
        {weightChanges.length > 0 && (
          <li>
            Weights change:{' '}
            {weightChanges.map((c) => `${c.title} ${c.from ?? '—'}% → ${c.to}%`).join(', ')}.
          </li>
        )}
      </ul>
      {needsAck && (
        <div className="space-y-3 rounded-xl border border-ahly-gold/50 bg-ahly-gold-light/50 p-4 text-sm text-amber-950">
          <p>
            <strong>
              {evaluations.onPublished} evaluation{evaluations.onPublished === 1 ? '' : 's'} already
              use version {published!.versionNo}
            </strong>{' '}
            ({evaluations.submittedOnPublished} submitted). They keep version {published!.versionNo}{' '}
            and its weights, and their scores don’t change. Results will show that two versions were
            used.
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-ischool-blue"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>I understand, publish the new version anyway.</span>
          </label>
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={confirm} disabled={busy || (needsAck && !acknowledged)}>
          {busy ? 'Publishing…' : `Publish version ${versionNo}`}
        </Button>
      </div>
    </Modal>
  );
}

function RubricHistory({
  versions,
  activeId,
  canRestore,
  onRestore,
}: {
  versions: RubricVersion[];
  activeId?: number;
  canRestore: boolean;
  onRestore: (id: number) => void;
}) {
  const [preview, setPreview] = useState<RubricVersion | null>(null);
  return (
    <Card className="space-y-3">
      <h2 className="text-lg font-bold">Rubric Version History</h2>
      <p className="text-sm text-muted">
        Published versions are preserved even when no evaluations use them. Restoring creates a new
        draft and never transfers evaluations.
      </p>
      {versions.map((v) => (
        <div
          key={v.id}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3"
        >
          <div>
            <p className="font-semibold">
              Version {v.versionNo}{' '}
              <Badge tone={v.id === activeId ? 'green' : 'gray'}>
                {v.id === activeId
                  ? 'Active for NEW evaluations'
                  : v.status === 'draft'
                    ? 'Unpublished draft'
                    : 'Historical published version'}
              </Badge>
            </p>
            <p className="text-sm text-muted">
              {v.publishedAt ? `Published ${formatDate(v.publishedAt)}` : 'Not published'} ·{' '}
              {isPointsRubric(v) ? 'Numeric points' : 'Star scoring'}
              {v.title ? ` · ${v.title}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPreview(v)}>
              Preview version {v.versionNo}
            </Button>
            {v.status !== 'draft' && (
              <Button disabled={!canRestore} onClick={() => onRestore(v.id)}>
                Restore as New Draft
              </Button>
            )}
          </div>
        </div>
      ))}
      {!canRestore && (
        <p className="text-xs text-muted">
          Save and publish, or discard the current draft, before restoring another version.
        </p>
      )}
      {preview && (
        <Modal
          title={`Preview version ${preview.versionNo}`}
          onClose={() => setPreview(null)}
          size="lg"
          focusPanel
          footer={
            <Button variant="secondary" onClick={() => setPreview(null)}>
              Close preview
            </Button>
          }
        >
          <RubricView rubric={contentOf(preview)} />
        </Modal>
      )}
    </Card>
  );
}
