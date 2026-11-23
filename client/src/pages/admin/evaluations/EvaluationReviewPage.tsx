import { useCompetition } from '../../../components/CompetitionNotice';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  EVALUATION_PROGRESS_LABELS,
  REOPEN_REASON,
  formatScore,
  maximumScore,
  type AdminEvaluationDetail,
  type EvaluationEvent,
  type EvaluationHistoryResponse,
} from '@judging/shared';
import { api } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { FullPageSpinner } from '../../../components/FullPageSpinner';
import { Modal } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import { Alert, Badge, Button, Card } from '../../../components/ui';
import { inputOf } from '../../judge/useEvaluationAutosave';
import { Info, RubricIntro, ScoringForm } from '../../judge/EvaluationPage';
import { EditSubmission, SubmissionComparison } from './EditSubmission';
import { PROGRESS_TONES, formatDateTime } from './EvaluationsPage';

const EVENT_STYLE: Record<EvaluationEvent['event'], { label: string; dot: string }> = {
  admin_corrected: { label: 'Corrected by an administrator', dot: 'bg-ischool-blue' },
  started: { label: 'Evaluation started', dot: 'bg-black/30' },
  draft_saved: { label: 'Draft saved', dot: 'bg-ischool-blue' },
  submitted: { label: 'Submitted', dot: 'bg-emerald-600' },
  reopened: { label: 'Reopened by an administrator', dot: 'bg-ahly-gold' },
  resubmitted: { label: 'Resubmitted', dot: 'bg-emerald-600' },
};

function HistoryItem({ e }: { e: EvaluationEvent }) {
  const [open, setOpen] = useState(false);
  const style = EVENT_STYLE[e.event];
  return (
    <li className="relative pl-7">
      <span
        className={`absolute top-1.5 left-0 h-3 w-3 rounded-full ring-4 ring-white ${style.dot}`}
        aria-hidden
      />
      <p className="font-semibold">{style.label}</p>
      <p className="text-xs text-muted">
        {formatDateTime(e.createdAt)} · {e.actorName ?? e.actorEmail ?? 'Unknown'}
        {e.actorName && e.actorEmail ? ` (${e.actorEmail})` : ''} · rubric v{e.rubricVersionNo}
      </p>
      <div className="mt-1 space-y-1 text-sm">
        {e.event === 'draft_saved' && (
          <p className="text-black/65">
            {e.ratedCount} required rated
            {e.totalScore != null && ` · ${formatScore(e.totalScore)} so far`}
          </p>
        )}
        {(e.event === 'submitted' || e.event === 'resubmitted') && e.totalScore != null && (
          <p>
            Score <strong>{formatScore(e.totalScore)}</strong> / {e.snapshot?.maximumScore ?? 100}
            {e.previousScore != null && (
              <span className="text-black/60">
                {' '}
                (previous submission {formatScore(e.previousScore)})
              </span>
            )}
          </p>
        )}
        {e.event === 'admin_corrected' && (
          <>
            <p>Reason: {e.reason}</p>
            <p>
              Score {formatScore(e.previousScore ?? 0)} ? {formatScore(e.totalScore ?? 0)}
            </p>
            {e.previousSnapshot && e.snapshot && (
              <details>
                <summary className="cursor-pointer text-ischool-blue-dark">
                  Show before and after correction
                </summary>
                <SubmissionComparison before={e.previousSnapshot} after={e.snapshot} />
              </details>
            )}
          </>
        )}
        {e.event === 'reopened' && (
          <>
            <p>
              Reason: <q>{e.reason}</q>
            </p>
            {e.previousScore != null && (
              <p className="text-black/60">
                Submitted score at the time: {formatScore(e.previousScore)}
              </p>
            )}
          </>
        )}
        {e.snapshot && (
          <>
            <button
              type="button"
              className="text-sm font-semibold text-ischool-blue-dark hover:underline"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide' : 'Show'} what was submitted
            </button>
            {open && (
              <div className="space-y-2 rounded-xl border border-black/10 p-3">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-black/5">
                    {e.snapshot.sections.map((s) => (
                      <tr key={s.sectionId}>
                        <th scope="row" className="py-1 text-left font-semibold">
                          {s.title} (
                          {s.type === 'bonus'
                            ? `Bonus +${s.maxBonusPoints} max`
                            : `${s.weightPercent}%`}
                          )
                        </th>
                        <td className="py-1 text-black/70">
                          {e
                            .snapshot!.ratings.filter((r) => r.sectionId === s.sectionId)
                            .map(
                              (r) =>
                                `${r.title}: ${r.rating == null ? 'Not rated' : `${r.rating}★`}`,
                            )
                            .join(' · ')}
                        </td>
                        <td className="py-1 text-right tabular-nums">{formatScore(s.score)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {e.snapshot.ratings.some((r) => r.note) ||
                e.snapshot.sections.some((s) => s.note) ||
                e.snapshot.overallNotes ? (
                  <div className="space-y-1 text-xs text-black/70">
                    {e.snapshot.ratings
                      .filter((r) => r.note)
                      .map((r) => (
                        <p key={r.criterionId}>
                          <strong>{r.title}:</strong> {r.note}
                        </p>
                      ))}
                    {e.snapshot.sections
                      .filter((s) => s.note)
                      .map((s) => (
                        <p key={s.sectionId}>
                          <strong>{s.title} (section):</strong> {s.note}
                        </p>
                      ))}
                    {e.snapshot.overallNotes && (
                      <p>
                        <strong>Overall:</strong> {e.snapshot.overallNotes}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted">No notes.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function ReopenDialog({
  detail,
  ownEvaluation,
  onClose,
  onReopened,
}: {
  detail: AdminEvaluationDetail;
  ownEvaluation: boolean;
  onClose: () => void;
  onReopened: (d: AdminEvaluationDetail) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();
  const valid = trimmed.length >= REOPEN_REASON.min && trimmed.length <= REOPEN_REASON.max;

  async function confirm() {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<AdminEvaluationDetail>(
        `/api/admin/evaluations/${detail.evaluation.id}/reopen`,
        { method: 'POST', body: { reason: trimmed } },
      );
      onReopened(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Reopen ${detail.judge.fullName}’s evaluation of ${detail.team.teamCode}?`}
      description="The judge can then change it and must submit it again."
      onClose={onClose}
      canClose={!busy}
    >
      {error && <Alert tone="error">{error}</Alert>}
      {ownEvaluation && (
        <Alert tone="warning" title="This is your own evaluation">
          To avoid a conflict of interest, it’s better if another administrator reopens it. The
          audit log records that you reopened your own evaluation.
        </Alert>
      )}
      <ul className="list-disc space-y-1 pl-5 text-sm text-black/70">
        <li>
          It goes back to Draft and no longer counts as submitted until {detail.judge.fullName}{' '}
          submits it again.
        </li>
        <li>
          The submitted score ({formatScore(detail.evaluation.totalScore)}) and notes stay in the
          history permanently.
        </li>
        <li>
          It keeps rubric version {detail.evaluation.rubricVersionNo}. Other judges’ evaluations are
          not affected.
        </li>
        <li>The judge sees a notice with your reason.</li>
      </ul>
      <div className="space-y-1.5">
        <label htmlFor="reopen-reason" className="block text-sm font-medium">
          Reason (required)
        </label>
        <textarea
          id="reopen-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REOPEN_REASON.max}
          rows={3}
          placeholder="For example: Section 2 was scored for the wrong team."
          aria-describedby="reopen-reason-hint"
          className="block w-full rounded-xl border border-black/15 px-3.5 py-2.5 text-base shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 sm:text-sm"
        />
        <p id="reopen-reason-hint" className="text-xs text-muted">
          At least {REOPEN_REASON.min} characters. {trimmed.length}/{REOPEN_REASON.max}
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" variant="danger" onClick={confirm} disabled={busy || !valid}>
          {busy ? 'Reopening…' : 'Reopen evaluation'}
        </Button>
      </div>
    </Modal>
  );
}

export function EvaluationReviewPage() {
  const lifecycle = useCompetition();
  const lifecycleBlocked = !!lifecycle.data && lifecycle.data.state !== 'judging_open';
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reopening, setReopening] = useState(false);
  const [params, setParams] = useSearchParams();
  const editing = params.get('edit') === '1';
  const setEditing = (open: boolean) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (open) next.set('edit', '1');
        else next.delete('edit');
        return next;
      },
      { replace: true },
    );
  const detailQuery = useQuery({
    queryKey: ['admin', 'evaluation', id],
    queryFn: () => api<AdminEvaluationDetail>(`/api/admin/evaluations/${id}`),
  });
  const historyQuery = useQuery({
    queryKey: ['admin', 'evaluation', id, 'history'],
    queryFn: () => api<EvaluationHistoryResponse>(`/api/admin/evaluations/${id}/history`),
  });

  const back = (
    <Link
      to={
        params.get('teamId')
          ? `/admin/evaluations?${new URLSearchParams({ teamId: params.get('teamId')! })}`
          : '/admin/evaluations'
      }
      className="text-sm font-semibold text-ischool-blue-dark hover:underline"
    >
      ← Evaluations
    </Link>
  );
  if (detailQuery.isPending) return <FullPageSpinner label="Loading the evaluation…" />;
  if (detailQuery.isError) {
    return (
      <div className="space-y-4">
        {back}
        <Alert tone="error" title="Could not load this evaluation">
          {detailQuery.error.message}
        </Alert>
      </div>
    );
  }
  const d = detailQuery.data;
  const e = d.evaluation;
  const outdated = d.publishedVersionNo != null && e.rubricVersionNo !== d.publishedVersionNo;

  return (
    <div className="space-y-6">
      {back}
      {d.lastAdminCorrection && (
        <Alert tone="info" title="Modified by an administrator">
          Last correction {formatDateTime(d.lastAdminCorrection.at)} by{' '}
          {d.lastAdminCorrection.byEmail}.
        </Alert>
      )}
      {(d.team.status === 'archived' || !d.judgeAssigned) && (
        <Alert tone="warning" title="Historical submission">
          This evaluation is excluded from official rankings.
        </Alert>
      )}
      {editing && e.status === 'submitted' && d.canCorrect !== false && !lifecycleBlocked && (
        <EditSubmission
          key={e.id}
          detail={d}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            queryClient.setQueryData(['admin', 'evaluation', id], updated);
            void queryClient.invalidateQueries({ queryKey: ['admin'] });
            void queryClient.invalidateQueries({ queryKey: ['judge'] });
            toast('Submission corrected. Status remains Submitted.');
          }}
        />
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Evaluation Details</p>
          <h1 className="text-2xl font-bold sm:text-3xl">
            {d.judge.fullName} → {d.team.teamCode}
          </h1>
        </div>
        {e.status === 'submitted' && (
          <Button
            disabled={d.canCorrect === false || lifecycleBlocked}
            onClick={() => setEditing(true)}
          >
            Edit Submission
          </Button>
        )}
        {e.status === 'submitted' && (
          <Button
            variant="secondary"
            className="!text-ahly-red-dark"
            onClick={() => setReopening(true)}
            disabled={!d.canReopen || lifecycleBlocked}
          >
            Reopen…
          </Button>
        )}
      </div>
      {e.status === 'submitted' && !d.canReopen && d.reopenBlockedReason && (
        <Alert tone="info">{d.reopenBlockedReason}</Alert>
      )}
      {d.reopen && e.status === 'draft' && (
        <Alert tone="warning" title="Reopened, waiting for the judge to resubmit">
          Reopened {formatDateTime(d.reopen.at)} by {d.reopen.byEmail ?? 'an administrator'}.
          Reason: “{d.reopen.reason}”.
        </Alert>
      )}
      {outdated && (
        <Alert tone="warning" title="Uses an older rubric version">
          This evaluation uses version {e.rubricVersionNo}; the published rubric is version{' '}
          {d.publishedVersionNo}. Scores from different versions use different weights and may not
          be comparable.
        </Alert>
      )}
      {!d.judgeAssigned && (
        <Alert tone="info">
          {d.judge.fullName} is no longer assigned to this team. The evaluation is kept for the
          record.
        </Alert>
      )}

      <Card className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Team" value={`${d.team.teamCode} · ${d.team.name}`} />
        <Info label="Project" value={d.team.projectName} />
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Judge</p>
          <p className="mt-1 font-semibold">
            {d.judge.fullName} {d.judge.role === 'admin' && <Badge tone="red">Admin</Badge>}{' '}
            {d.judge.accountStatus === 'disabled' && <Badge tone="gray">Disabled</Badge>}
          </p>
          <p className="text-sm break-all text-black/60">{d.judge.email}</p>
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Status</p>
          <p className="mt-1">
            <Badge tone={PROGRESS_TONES[e.status]}>{EVALUATION_PROGRESS_LABELS[e.status]}</Badge>
            {d.team.status === 'archived' && (
              <span className="ml-1">
                <Badge tone="gray">Team archived</Badge>
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-muted">
            {e.submittedAt
              ? `Submitted ${formatDateTime(e.submittedAt)}`
              : `${e.ratedCount}/{e.requiredCount} rated`}
          </p>
        </div>
      </Card>

      <Card className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            Rubric version {e.rubricVersionNo} section scores
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {d.rubric.sections.map((s, i) => (
              <li key={s.id}>
                {s.title}{' '}
                {s.type === 'bonus' ? `Bonus +${s.maxBonusPoints} max` : `${s.weightPercent}%`} →{' '}
                <strong className="tabular-nums">
                  {d.sectionScores[i] != null ? formatScore(d.sectionScores[i]!) : '—'}
                </strong>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Last saved {formatDateTime(d.lastSavedAt)} · {d.saveCount} save
            {d.saveCount === 1 ? '' : 's'}
            {d.reopen && ` · reopened ${d.reopen.count} time${d.reopen.count === 1 ? '' : 's'}`}
          </p>
        </div>
        <p className="text-right">
          <span className="block text-xs font-semibold tracking-wide text-muted uppercase">
            {e.status === 'submitted' ? 'Final score' : 'Score so far'}
          </span>
          <span className="text-3xl font-bold text-ischool-blue-dark tabular-nums">
            {formatScore(e.totalScore)}
          </span>
          <span className="text-muted"> / {maximumScore(d.rubric.sections)}</span>
        </p>
      </Card>

      <RubricIntro rubric={d.rubric} nested />
      <ScoringForm rubric={d.rubric} input={inputOf(e)} readOnly />

      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="text-lg font-semibold">
          History
        </h2>
        <Card>
          {historyQuery.isPending ? (
            <p className="text-sm text-muted">Loading history…</p>
          ) : historyQuery.isError ? (
            <Alert tone="error">{historyQuery.error.message}</Alert>
          ) : historyQuery.data.events.length === 0 ? (
            <p className="text-sm text-muted">No history recorded.</p>
          ) : (
            <ol className="relative space-y-5 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-0.5 before:bg-black/10">
              {historyQuery.data.events.map((ev) => (
                <HistoryItem key={ev.id} e={ev} />
              ))}
            </ol>
          )}
          <p className="mt-4 text-xs text-muted">
            Draft saves are recorded at most every 10 minutes; the save count above includes every
            save.
          </p>
        </Card>
      </section>

      {reopening && (
        <ReopenDialog
          detail={d}
          ownEvaluation={d.judge.id === user?.id}
          onClose={() => setReopening(false)}
          onReopened={(updated) => {
            setReopening(false);
            queryClient.setQueryData(['admin', 'evaluation', id], updated);
            void queryClient.invalidateQueries({ queryKey: ['admin'] });
            toast(`Evaluation reopened. ${d.judge.fullName} has been notified.`);
          }}
        />
      )}
    </div>
  );
}
