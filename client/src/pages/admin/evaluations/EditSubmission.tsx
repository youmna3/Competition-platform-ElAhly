import { useState } from 'react';
import {
  scoreEvaluation,
  formatScore,
  maximumScore,
  type AdminEvaluationDetail,
  type SubmissionSnapshot,
} from '@judging/shared';
import { api, ApiError } from '../../../api/client';
import { Modal } from '../../../components/Modal';
import { Alert, Button, TextField } from '../../../components/ui';
import { ScoringForm } from '../../judge/EvaluationPage';
import { inputOf } from '../../judge/useEvaluationAutosave';

export function SubmissionComparison({
  before,
  after,
}: {
  before: SubmissionSnapshot;
  after: SubmissionSnapshot;
}) {
  const rows: [string, string, string, string][] = [
    ['total', 'Final score', formatScore(before.totalScore), formatScore(after.totalScore)],
    [
      'base',
      'Base score',
      formatScore(before.baseScore ?? before.totalScore),
      formatScore(after.baseScore ?? after.totalScore),
    ],
    [
      'bonus',
      'Bonus score',
      formatScore(before.bonusScore ?? 0),
      formatScore(after.bonusScore ?? 0),
    ],
    ...after.sections.flatMap((s): [string, string, string, string][] => {
      const old = before.sections.find((x) => x.sectionId === s.sectionId);
      return [
        [
          `section-${s.sectionId}-score`,
          `${s.title} score`,
          formatScore(old?.score ?? 0),
          formatScore(s.score),
        ],
        [`section-${s.sectionId}-notes`, `${s.title} notes`, old?.note ?? '', s.note],
      ];
    }),
    ...after.ratings.flatMap((r): [string, string, string, string][] => {
      const old = before.ratings.find((x) => x.criterionId === r.criterionId);
      return [
        [
          `criterion-${r.criterionId}-rating`,
          `${r.title} stars`,
          old?.rating == null ? 'Not rated' : String(old.rating),
          r.rating == null ? 'Not rated' : String(r.rating),
        ],
        [`criterion-${r.criterionId}-notes`, `${r.title} notes`, old?.note ?? '', r.note],
      ];
    }),
    ['overall', 'Overall comments', before.overallNotes, after.overallNotes],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Before and after correction</caption>
        <thead>
          <tr>
            <th className="p-3">Field</th>
            <th className="p-3">Before</th>
            <th className="p-3">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, label, old, value]) => (
            <tr key={id} className={old !== value ? 'bg-ischool-blue-soft' : ''}>
              <th className="p-3">{label}</th>
              <td className="whitespace-pre-wrap p-3">{old || 'No notes'}</td>
              <td className="whitespace-pre-wrap p-3">{value || 'No notes'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EditSubmission({
  detail,
  onClose,
  onSaved,
}: {
  detail: AdminEvaluationDetail;
  onClose: () => void;
  onSaved: (d: AdminEvaluationDetail) => void;
}) {
  // One captured session: never adopt a background query's version with older inputs.
  const [session, setSession] = useState(() => ({
    baseline: structuredClone(detail),
    input: inputOf(structuredClone(detail.evaluation)),
  }));
  const { baseline, input } = session;
  const setInput = (input: typeof session.input) =>
    setSession((current) => ({ ...current, input }));
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const rubric = baseline.rubric;
  function snapshot(value: typeof input): SubmissionSnapshot {
    const scores = scoreEvaluation(
      rubric.sections,
      rubric.sections.map((s) =>
        s.criteria.map((c) => value.ratings.find((r) => r.criterionId === c.id)?.rating ?? null),
      ),
    );
    return {
      totalScore: scores.total ?? 0,
      baseScore: scores.base ?? 0,
      bonusScore: scores.bonus ?? 0,
      maximumScore: scores.maximum,
      overallNotes: value.overallNotes,
      sections: rubric.sections.map((s, i) => ({
        sectionId: s.id,
        title: s.title,
        weightPercent: s.weightPercent ?? 0,
        score: scores.sections[i]?.score ?? 0,
        note: value.sectionNotes.find((n) => n.sectionId === s.id)?.note ?? '',
      })),
      ratings: rubric.sections.flatMap((s) =>
        s.criteria.map((c) => ({
          criterionId: c.id,
          sectionId: s.id,
          title: c.title,
          rating: value.ratings.find((r) => r.criterionId === c.id)?.rating ?? null,
          note: value.ratings.find((r) => r.criterionId === c.id)?.note ?? '',
        })),
      ),
    };
  }
  const before = {
    ...snapshot(inputOf(baseline.evaluation)),
    totalScore: baseline.evaluation.totalScore,
    baseScore: baseline.evaluation.baseScore,
    bonusScore: baseline.evaluation.bonusScore,
    sections: snapshot(inputOf(baseline.evaluation)).sections.map((s, i) => ({
      ...s,
      score: baseline.sectionScores[i] ?? s.score,
    })),
  };
  const after = snapshot(input);
  const complete =
    scoreEvaluation(
      rubric.sections,
      rubric.sections.map((s) =>
        s.criteria.map((c) => input.ratings.find((r) => r.criterionId === c.id)?.rating ?? null),
      ),
    ).total != null;
  async function reload(keepChanges: boolean) {
    setBusy(true);
    setError(null);
    try {
      const latest = await api<AdminEvaluationDetail>(
        `/api/admin/evaluations/${baseline.evaluation.id}`,
      );
      if (latest.evaluation.status !== 'submitted')
        throw new Error(
          'This evaluation was reopened. Close the editor and review the current draft.',
        );
      setSession((current) => ({
        baseline: structuredClone(latest),
        input: keepChanges ? current.input : inputOf(structuredClone(latest.evaluation)),
      }));
      setConflict(false);
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reload current submission.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api<AdminEvaluationDetail>(
          `/api/admin/evaluations/${baseline.evaluation.id}/submission`,
          {
            method: 'PUT',
            body: {
              ...input,
              rowVersion: baseline.evaluation.rowVersion,
              reason: reason.trim(),
              confirmed: true,
            },
          },
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      setError(e instanceof Error ? e.message : 'Could not save correction.');
      setBusy(false);
    }
  }
  return (
    <Modal
      key={confirm ? 'confirm' : 'edit'}
      focusPanel={confirm}
      size="lg"
      title={confirm ? 'Confirm submission correction' : 'Edit Submission'}
      onClose={onClose}
      canClose={!busy}
      description={`${baseline.judge.fullName} · ${baseline.team.teamCode} · original rubric v${rubric.versionNo}. Status stays Submitted.`}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {confirm ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm(false)}>
                Back to editing
              </Button>
              <Button disabled={busy || conflict} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Confirm and save correction'}
              </Button>
            </>
          ) : (
            <Button
              disabled={!complete || reason.trim().length < 5 || reason.trim().length > 500}
              onClick={() => setConfirm(true)}
            >
              Review changes
            </Button>
          )}
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      {conflict && (
        <Alert tone="warning" title="Submission changed — your unsaved changes are retained">
          Another administrator changed or reopened this evaluation. Reload current data before
          saving and review the comparison again.
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => void reload(true)}>
              Reload current data; keep my edits
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void reload(false)}>
              Reload and discard my edits
            </Button>
          </div>
        </Alert>
      )}
      {(baseline.team.status === 'archived' || !baseline.judgeAssigned) && (
        <Alert tone="warning" title="Historical submission">
          This correction does not restore assignment or ranking eligibility.
        </Alert>
      )}
      <p className="font-semibold text-ischool-blue-dark">
        Final score: {complete ? formatScore(after.totalScore) : 'Incomplete'} /{' '}
        {maximumScore(rubric.sections)}
      </p>
      {!complete && (
        <Alert tone="warning">
          Complete all Actual ratings and all questions in any Bonus section you start, or choose
          Skip bonus.
        </Alert>
      )}
      {confirm ? (
        <>
          <Alert tone="info">
            Reason: {reason.trim()}. Original and corrected values will be retained permanently.
          </Alert>
          <SubmissionComparison before={before} after={after} />
        </>
      ) : (
        <>
          <TextField
            label="Reason for editing (required)"
            value={reason}
            minLength={5}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            hint="5–500 characters. This reason is recorded in history."
          />
          <ScoringForm rubric={rubric} input={input} onChange={setInput} />
        </>
      )}
    </Modal>
  );
}
