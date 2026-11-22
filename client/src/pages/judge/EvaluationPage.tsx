import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  EVALUATION_ERRORS,
  EVALUATION_LIMITS,
  formatScore,
  scoreEvaluation,
  type EvaluationDetail,
  type EvaluationInput,
  type JudgeEvaluationResponse,
  type RubricVersion,
  type SubmitEvaluationResponse,
} from '@judging/shared';
import { ApiError, api } from '../../api/client';
import { FullPageSpinner } from '../../components/FullPageSpinner';
import { Modal } from '../../components/Modal';
import { StarRating } from '../../components/StarRating';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card } from '../../components/ui';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import {
  clearBackup,
  inputOf,
  readBackup,
  useEvaluationAutosave,
  type SaveState,
} from './useEvaluationAutosave';

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

/** Ratings in rubric order, for the shared scoring function. */
function matrix(rubric: RubricVersion, input: EvaluationInput) {
  const byId = new Map(input.ratings.map((r) => [r.criterionId, r.rating]));
  return rubric.sections.map((s) => s.criteria.map((c) => byId.get(c.id) ?? null));
}

export function EvaluationPage() {
  const { teamId } = useParams();
  const queryKey = ['judge', 'evaluation', teamId];
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey,
    queryFn: () => api<JudgeEvaluationResponse>(`/api/judge/teams/${teamId}/evaluation`),
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const setEvaluation = useCallback(
    (evaluation: EvaluationDetail) => {
      queryClient.setQueryData<JudgeEvaluationResponse>(queryKey, (old) =>
        old
          ? {
              ...old,
              evaluation,
              canEdit: evaluation.status === 'draft' && old.team.status === 'active',
              readOnlyReason:
                evaluation.status === 'submitted'
                  ? 'Submitted and locked. Only an administrator can reopen it.'
                  : old.readOnlyReason,
            }
          : old,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, teamId],
  );

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      const result = await api<{ evaluation: EvaluationDetail }>(
        `/api/judge/teams/${teamId}/evaluation`,
        { method: 'POST' },
      );
      setEvaluation(result.evaluation);
      void queryClient.invalidateQueries({ queryKey: ['judge', 'assignments'] });
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Could not start the evaluation.');
    } finally {
      setStarting(false);
    }
  }

  if (query.isPending) return <FullPageSpinner label="Loading the evaluation…" />;
  if (query.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Alert tone="error" title="Could not open this team">
          {query.error.message}
        </Alert>
      </div>
    );
  }
  const data = query.data;
  const { team, rubric, evaluation } = data;
  const outdated =
    evaluation != null &&
    data.publishedVersionNo != null &&
    evaluation.rubricVersionNo !== data.publishedVersionNo;

  const header = (
    <div className="space-y-4">
      <BackLink />
      {evaluation?.adminModifiedAt && (
        <Alert tone="info" title="Modified by an administrator">
          Last administrator correction: {formatDateTime(evaluation.adminModifiedAt)}.
        </Alert>
      )}
      <Card className="grid gap-4 sm:grid-cols-3">
        <Info label="Team ID" value={team.teamCode} />
        <Info label="Team" value={team.name} />
        <Info label="Project" value={team.projectName} />
      </Card>
      {outdated && (
        <Alert tone="warning" title="This evaluation uses an older rubric version">
          It was started on version {evaluation!.rubricVersionNo}, and the published rubric is now
          version {data.publishedVersionNo}. It stays on version {evaluation!.rubricVersionNo} with
          that version’s weights. The administrator is notified that versions differ.
        </Alert>
      )}
    </div>
  );

  if (!rubric) {
    return (
      <div className="space-y-6">
        {header}
        <Card className="py-12 text-center">
          <p className="text-lg font-semibold">Judging hasn’t started yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-black/60">
            The administrator hasn’t published the rubric. Check back later.
          </p>
        </Card>
      </div>
    );
  }

  if (!evaluation) {
    return (
      <div className="space-y-6">
        {header}
        <RubricIntro rubric={rubric} />
        <Card className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-semibold">Ready to evaluate {team.name}?</p>
            <p className="text-sm text-black/60">
              Your ratings save automatically as a draft. Nothing is final until you submit.
            </p>
          </div>
          {data.canEdit ? (
            <Button onClick={start} disabled={starting}>
              {starting ? 'Starting…' : 'Start evaluation'}
            </Button>
          ) : (
            <Badge tone="gray">{data.readOnlyReason}</Badge>
          )}
        </Card>
        {startError && <Alert tone="error">{startError}</Alert>}
        <ScoringForm rubric={rubric} input={inputOf(emptyEvaluation(rubric))} readOnly />
      </div>
    );
  }

  if (!data.canEdit) {
    return (
      <div className="space-y-6">
        {header}
        {evaluation.status === 'submitted' ? (
          <Card className="flex flex-wrap items-center justify-between gap-4 border-emerald-600/25 bg-emerald-50/50">
            <div>
              <p className="font-semibold text-emerald-800">Submitted and locked</p>
              <p className="text-sm text-black/65">
                Submitted {formatDateTime(evaluation.submittedAt!)}. Only an administrator can
                reopen it.
              </p>
            </div>
            <p className="text-right">
              <span className="block text-xs font-semibold tracking-wide text-muted uppercase">
                Final score
              </span>
              <span className="text-3xl font-bold text-ischool-blue-dark">
                {formatScore(evaluation.totalScore)}
              </span>
              <span className="text-muted"> / 100</span>
            </p>
          </Card>
        ) : (
          <Alert tone="warning">{data.readOnlyReason}</Alert>
        )}
        <RubricIntro rubric={rubric} />
        <ScoringForm rubric={rubric} input={inputOf(evaluation)} readOnly />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-28">
      {header}
      <RubricIntro rubric={rubric} />
      <EditableEvaluation
        key={evaluation.id}
        rubric={rubric}
        evaluation={evaluation}
        teamName={team.name}
        onSaved={setEvaluation}
        onSubmitted={(e) => {
          setEvaluation(e);
          clearBackup(e.id);
          void queryClient.invalidateQueries({ queryKey: ['judge', 'assignments'] });
          document.getElementById('root')?.scrollIntoView?.({ behavior: 'smooth' });
          toast(`Evaluation submitted. Final score ${formatScore(e.totalScore)} / 100.`);
        }}
      />
    </div>
  );
}

function emptyEvaluation(rubric: RubricVersion): EvaluationDetail {
  return {
    id: 0,
    teamId: 0,
    judgeId: 0,
    rubricVersionId: rubric.id,
    rubricVersionNo: rubric.versionNo,
    status: 'draft',
    rowVersion: 0,
    totalScore: 0,
    ratedCount: 0,
    requiredCount: 8,
    submittedAt: null,
    createdAt: '',
    updatedAt: '',
    reopenedCount: 0,
    reopenedAt: null,
    reopenReason: null,
    reopenNoticePending: false,
    overallNotes: '',
    ratings: rubric.sections.flatMap((s) =>
      s.criteria.map((c) => ({ criterionId: c.id, rating: null, note: '' })),
    ),
    sectionNotes: rubric.sections.map((s) => ({ sectionId: s.id, note: '' })),
  };
}

function BackLink() {
  return (
    <Link to="/judge" className="text-sm font-semibold text-ischool-blue-dark hover:underline">
      ← My teams
    </Link>
  );
}

export function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}

export function RubricIntro({
  rubric,
  nested = false,
}: {
  rubric: RubricVersion;
  nested?: boolean;
}) {
  const Heading = nested ? 'h2' : 'h1';
  return (
    <Card className="space-y-2">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        Rubric · version {rubric.versionNo}
      </p>
      <Heading className="text-xl font-bold sm:text-2xl">{rubric.title}</Heading>
      {rubric.instructions && (
        <p className="whitespace-pre-wrap text-sm text-black/70">{rubric.instructions}</p>
      )}
      <p className="text-xs text-muted">
        Section score = (rating 1 + rating 2) ÷ 10 × section weight. Final score = the four section
        scores added together, out of 100.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The form itself (editable or read-only)
// ---------------------------------------------------------------------------

function NoteField({
  label,
  value,
  onChange,
  maxLength,
  readOnly,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  maxLength: number;
  readOnly?: boolean;
  rows?: number;
}) {
  if (readOnly) {
    return value ? (
      <div className="rounded-xl bg-black/[0.03] px-3.5 py-2.5 text-sm">
        <p className="text-xs font-semibold text-muted">{label}</p>
        <p className="mt-0.5 whitespace-pre-wrap">{value}</p>
      </div>
    ) : null;
  }
  return (
    <label className="block space-y-1">
      <span className="text-xs font-semibold text-black/60">{label}</span>
      <textarea
        value={value}
        maxLength={maxLength}
        rows={rows}
        onChange={(e) => onChange?.(e.target.value)}
        className="block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
      />
    </label>
  );
}

export function ScoringForm({
  rubric,
  input,
  onChange,
  readOnly = false,
  missing,
}: {
  rubric: RubricVersion;
  input: EvaluationInput;
  onChange?: (next: EvaluationInput) => void;
  readOnly?: boolean;
  /** Criterion ids to highlight as still unrated. */
  missing?: Set<number>;
}) {
  const breakdown = scoreEvaluation(rubric.sections, matrix(rubric, input));
  const rating = new Map(input.ratings.map((r) => [r.criterionId, r]));
  const sectionNote = new Map(input.sectionNotes.map((n) => [n.sectionId, n.note]));

  const setRating = (criterionId: number, patch: { rating?: number | null; note?: string }) =>
    onChange?.({
      ...input,
      ratings: input.ratings.map((r) => (r.criterionId === criterionId ? { ...r, ...patch } : r)),
    });
  const setSectionNote = (sectionId: number, note: string) =>
    onChange?.({
      ...input,
      sectionNotes: input.sectionNotes.map((n) => (n.sectionId === sectionId ? { ...n, note } : n)),
    });

  return (
    <div className="space-y-5">
      {rubric.sections.map((s, i) => {
        const part = breakdown.sections[i]!;
        return (
          <Card key={s.id} className="!p-0">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/5 px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Section {i + 1} · {s.weightPercent}% of the final score
                </p>
                <h2 className="text-lg font-bold">{s.title}</h2>
                {s.description && (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-black/65">{s.description}</p>
                )}
              </div>
              <p className="shrink-0 text-right" aria-live="polite">
                <span className="block text-xs text-muted">Section score</span>
                <span className="text-xl font-bold tabular-nums">
                  {part.score != null ? formatScore(part.score) : '—'}
                </span>
                <span className="text-sm text-muted"> / {formatScore(s.weightPercent ?? 0)}</span>
              </p>
            </div>
            <ol className="divide-y divide-black/5">
              {s.criteria.map((c, j) => {
                const r = rating.get(c.id);
                const isMissing = missing?.has(c.id) ?? false;
                return (
                  <li
                    key={c.id}
                    id={`criterion-${c.id}`}
                    className={`space-y-2 px-5 py-4 sm:px-6 ${isMissing ? 'bg-red-50/70 ring-2 ring-ahly-red/40 ring-inset' : ''}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-semibold">
                        {i + 1}.{j + 1} {c.title}
                        {isMissing && (
                          <span className="ml-2 text-xs font-semibold text-ahly-red-dark">
                            Rating required
                          </span>
                        )}
                      </p>
                      {readOnly ? (
                        <StarRating label={c.title} value={r?.rating ?? null} size={26} />
                      ) : (
                        <StarRating
                          label={`Rating for ${c.title}`}
                          value={r?.rating ?? null}
                          onChange={(v) => setRating(c.id, { rating: v })}
                          size={30}
                        />
                      )}
                    </div>
                    {c.description && (
                      <p className="whitespace-pre-wrap text-sm text-black/70">{c.description}</p>
                    )}
                    {c.guidelines && (
                      <div className="rounded-xl bg-blue-50/70 px-3.5 py-2 text-sm">
                        <p className="text-xs font-semibold tracking-wide text-blue-900 uppercase">
                          Judging guidelines
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-blue-950/85">
                          {c.guidelines}
                        </p>
                      </div>
                    )}
                    <NoteField
                      label={`Note on ${c.title} (optional)`}
                      value={r?.note ?? ''}
                      onChange={(note) => setRating(c.id, { note })}
                      maxLength={EVALUATION_LIMITS.criterionNote}
                      readOnly={readOnly}
                    />
                  </li>
                );
              })}
            </ol>
            <div className="border-t border-black/5 px-5 py-4 sm:px-6">
              <NoteField
                label={`Note on ${s.title} (optional)`}
                value={sectionNote.get(s.id) ?? ''}
                onChange={(note) => setSectionNote(s.id, note)}
                maxLength={EVALUATION_LIMITS.sectionNote}
                readOnly={readOnly}
              />
            </div>
          </Card>
        );
      })}
      <Card className="space-y-3">
        <NoteField
          label="Overall notes (optional)"
          value={input.overallNotes}
          onChange={(overallNotes) => onChange?.({ ...input, overallNotes })}
          maxLength={EVALUATION_LIMITS.overallNotes}
          readOnly={readOnly}
          rows={4}
        />
        {readOnly && !input.overallNotes && <p className="text-sm text-muted">No overall notes.</p>}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editing a draft: autosave, conflicts, device backup, submission
// ---------------------------------------------------------------------------

function SaveIndicator({ state, dirty }: { state: SaveState; dirty: boolean }) {
  const content: [string, string] =
    state.kind === 'saving'
      ? ['text-black/60', 'Saving…']
      : state.kind === 'retrying'
        ? ['text-amber-800', 'Not saved yet, retrying…']
        : state.kind === 'failed'
          ? ['text-ahly-red-dark', 'Not saved']
          : state.kind === 'conflict'
            ? ['text-ahly-red-dark', 'Changed in another tab']
            : dirty || state.kind === 'pending'
              ? ['text-black/60', 'Unsaved changes…']
              : ['text-emerald-700', '✓ All changes saved'];
  return (
    <span role="status" aria-live="polite" className={`text-sm font-semibold ${content[0]}`}>
      {content[1]}
    </span>
  );
}

function EditableEvaluation({
  rubric,
  evaluation,
  teamName,
  onSaved,
  onSubmitted,
}: {
  rubric: RubricVersion;
  evaluation: EvaluationDetail;
  teamName: string;
  onSaved: (e: EvaluationDetail) => void;
  onSubmitted: (e: EvaluationDetail) => void;
}) {
  const auto = useEvaluationAutosave(evaluation, onSaved);
  const { input, state, dirty } = auto;
  const [backup, setBackup] = useState(() => {
    const b = readBackup(evaluation.id);
    return b && JSON.stringify(b.input) !== JSON.stringify(inputOf(evaluation)) ? b : null;
  });
  const [missing, setMissing] = useState<Set<number> | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Tell the server the judge has now seen that this evaluation was reopened.
  useEffect(() => {
    if (evaluation.reopenNoticePending) {
      void api(`/api/judge/evaluations/${evaluation.id}/acknowledge-reopen`, {
        method: 'POST',
      }).catch(() => {});
    }
  }, [evaluation.id, evaluation.reopenNoticePending]);
  useUnsavedChangesGuard(
    dirty || state.kind !== 'saved',
    'Your latest changes are not saved yet. Leave anyway?',
  );

  const breakdown = useMemo(
    () => scoreEvaluation(rubric.sections, matrix(rubric, input)),
    [rubric, input],
  );
  const rated = input.ratings.filter((r) => r.rating != null).length;
  const total = input.ratings.length;
  const partial = breakdown.sections.reduce((sum, s) => sum + (s.score ?? 0), 0);

  function change(next: EvaluationInput) {
    auto.setInput(next);
    if (missing) {
      const still = new Set(next.ratings.filter((r) => r.rating == null).map((r) => r.criterionId));
      setMissing(still.size ? still : null);
    }
  }

  function trySubmit() {
    const unrated = input.ratings.filter((r) => r.rating == null).map((r) => r.criterionId);
    if (unrated.length) {
      setMissing(new Set(unrated));
      document
        .getElementById(`criterion-${unrated[0]}`)
        ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      return;
    }
    setConfirming(true);
  }

  return (
    <>
      {evaluation.reopenedAt && evaluation.reopenedCount > 0 && (
        <Alert tone="warning" title="An administrator reopened this evaluation">
          <p>
            Reopened {formatDateTime(evaluation.reopenedAt)}. Reason: “{evaluation.reopenReason}”.
          </p>
          <p className="mt-1">
            Make your changes and submit it again. Until then it doesn’t count as submitted. Your
            previous submission is kept in the history.
          </p>
        </Alert>
      )}
      {backup && (
        <Alert tone="warning" title="Unsaved changes were found on this device">
          <p>
            From {formatDateTime(backup.savedAt)}. They were not saved to the server
            {backup.rowVersion !== evaluation.rowVersion
              ? ', and the evaluation has been saved from somewhere else since then'
              : ''}
            .
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              className="!py-1.5"
              onClick={() => {
                auto.restore(backup.input);
                setBackup(null);
              }}
            >
              Restore them
            </Button>
            <Button
              variant="secondary"
              className="!py-1.5"
              onClick={() => {
                clearBackup(evaluation.id);
                setBackup(null);
              }}
            >
              Discard them
            </Button>
          </div>
        </Alert>
      )}

      {state.kind === 'conflict' && (
        <Alert tone="error" title="This evaluation was changed in another tab or window">
          <p>
            Someone (probably you, in another tab) saved it after this page was opened. Nothing has
            been overwritten. Choose which version to keep.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="!py-1.5"
              onClick={() => auto.takeServerVersion(state.server)}
            >
              Load the saved version
            </Button>
            <Button className="!py-1.5" onClick={() => void auto.keepMine(state.server)}>
              Keep my changes and save them
            </Button>
          </div>
        </Alert>
      )}
      {(state.kind === 'failed' || state.kind === 'retrying') && (
        <Alert
          tone={state.kind === 'failed' ? 'error' : 'warning'}
          title="Your changes are not saved yet"
        >
          <p>
            {state.message} Your ratings and notes are kept on this page and on this device
            {state.kind === 'retrying' ? '; saving is retried automatically' : ''}.
          </p>
          <Button variant="secondary" className="mt-2 !py-1.5" onClick={() => void auto.saveNow()}>
            Try saving again
          </Button>
        </Alert>
      )}
      {missing && (
        <Alert tone="error" title={`Rate all ${total} criteria before submitting`}>
          {missing.size} criteri{missing.size === 1 ? 'on is' : 'a are'} still missing. They are
          highlighted below.
        </Alert>
      )}

      <ScoringForm rubric={rubric} input={input} onChange={change} missing={missing ?? undefined} />

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <SaveIndicator state={state} dirty={dirty} />
            <span className="text-sm text-black/60">
              {rated}/{total} rated
            </span>
            <span className="text-sm">
              {breakdown.total != null ? (
                <>
                  Final score{' '}
                  <strong className="text-ischool-blue-dark">{formatScore(breakdown.total)}</strong>{' '}
                  / 100
                </>
              ) : (
                <>
                  So far <strong>{formatScore(partial)}</strong> / 100
                </>
              )}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="!py-2"
              onClick={() => void auto.saveNow()}
              disabled={
                state.kind === 'saving' ||
                state.kind === 'conflict' ||
                (!dirty && state.kind === 'saved')
              }
            >
              Save
            </Button>
            <Button className="!py-2" onClick={trySubmit} disabled={state.kind === 'conflict'}>
              Submit…
            </Button>
          </div>
        </div>
      </div>

      {confirming && breakdown.total != null && (
        <SubmitDialog
          rubric={rubric}
          teamName={teamName}
          scores={breakdown.sections.map((s) => s.score ?? 0)}
          total={breakdown.total}
          onClose={() => setConfirming(false)}
          onSubmit={async () => {
            const saved = await auto.saveNow();
            if (!saved)
              throw new Error(
                'Your latest changes could not be saved, so nothing was submitted. Try again.',
              );
            const result = await api<SubmitEvaluationResponse>(
              `/api/judge/evaluations/${evaluation.id}/submit`,
              { method: 'POST', body: { rowVersion: auto.currentRowVersion() } },
            );
            setConfirming(false);
            onSubmitted(result.evaluation);
          }}
        />
      )}
    </>
  );
}

function SubmitDialog({
  rubric,
  teamName,
  scores,
  total,
  onClose,
  onSubmit,
}: {
  rubric: RubricVersion;
  teamName: string;
  scores: number[];
  total: number;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  async function confirm() {
    if (busy) return; // a second click while the first is running does nothing
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === EVALUATION_ERRORS.EVALUATION_INCOMPLETE
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Something went wrong.',
      );
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Submit your evaluation of ${teamName}?`}
      description="After submitting, the evaluation is locked. Only an administrator can reopen it."
      onClose={onClose}
      canClose={!busy}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <table className="w-full text-sm">
        <caption className="sr-only">Section scores</caption>
        <tbody className="divide-y divide-black/5">
          {rubric.sections.map((s, i) => (
            <tr key={s.id}>
              <th scope="row" className="py-1.5 text-left font-medium">
                {s.title}
              </th>
              <td className="py-1.5 text-right tabular-nums">
                {formatScore(scores[i] ?? 0)} / {formatScore(s.weightPercent ?? 0)}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-2 text-left text-base font-bold">
              Final score
            </th>
            <td className="py-2 text-right text-xl font-bold text-ischool-blue-dark tabular-nums">
              {formatScore(total)} / 100
            </td>
          </tr>
        </tbody>
      </table>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Keep editing
        </Button>
        <Button type="button" onClick={confirm} disabled={busy}>
          {busy ? 'Submitting…' : 'Submit evaluation'}
        </Button>
      </div>
    </Modal>
  );
}
