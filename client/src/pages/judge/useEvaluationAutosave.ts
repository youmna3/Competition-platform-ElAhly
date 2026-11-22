import { useCallback, useEffect, useRef, useState } from 'react';
import { EVALUATION_ERRORS, type EvaluationDetail, type EvaluationInput } from '@judging/shared';
import { ApiError, api } from '../../api/client';

export type SaveState =
  | { kind: 'saved' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'retrying'; message: string; attempt: number }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict'; server: EvaluationDetail };

const AUTOSAVE_DELAY_MS = 1200;
const RETRY_DELAYS_MS = [3000, 8000, 20000, 45000];

export const inputOf = (e: EvaluationDetail): EvaluationInput => ({
  ratings: e.ratings.map((r) => ({ ...r })),
  sectionNotes: e.sectionNotes.map((n) => ({ ...n })),
  overallNotes: e.overallNotes,
});
const snap = (i: EvaluationInput) => JSON.stringify(i);

// ---- Backup on this device, so a failed save or a closed tab loses nothing ----
interface Backup {
  rowVersion: number;
  input: EvaluationInput;
  savedAt: string;
}
const backupKey = (id: number) => `ischool-ahly:evaluation-backup:${id}`;
export function readBackup(id: number): Backup | null {
  try {
    const raw = window.localStorage.getItem(backupKey(id));
    return raw ? (JSON.parse(raw) as Backup) : null;
  } catch {
    return null;
  }
}
function writeBackup(id: number, backup: Backup) {
  try {
    window.localStorage.setItem(backupKey(id), JSON.stringify(backup));
  } catch {
    /* storage full or blocked: the in-memory copy is still kept */
  }
}
export function clearBackup(id: number) {
  try {
    window.localStorage.removeItem(backupKey(id));
  } catch {
    /* ignore */
  }
}

/**
 * Autosave for one draft evaluation. Saves shortly after each change, one
 * request at a time, always with the latest row version. Failed saves keep the
 * entered values (in memory and on this device) and retry; a save that loses a
 * race with another tab stops and reports a conflict instead of overwriting.
 */
export function useEvaluationAutosave(
  initial: EvaluationDetail,
  onSaved: (evaluation: EvaluationDetail) => void,
) {
  const id = initial.id;
  const [input, setInputState] = useState<EvaluationInput>(() => inputOf(initial));
  const [saved, setSaved] = useState(() => snap(inputOf(initial)));
  const [state, setState] = useState<SaveState>({ kind: 'saved' });

  const latest = useRef(input);
  const savedRef = useRef(saved);
  const rowVersion = useRef(initial.rowVersion);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const stopped = useRef(false); // conflict or locked: wait for the judge
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const dirty = snap(input) !== saved;

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const doSave = useCallback(
    async function save(): Promise<boolean> {
      if (inFlight.current) {
        await inFlight.current;
        if (snap(latest.current) === savedRef.current) return true;
      }
      const sending = latest.current;
      const body = { rowVersion: rowVersion.current, ...sending };
      setState({ kind: 'saving' });
      const run = (async () => {
        try {
          const result = await api<{ evaluation: EvaluationDetail }>(
            `/api/judge/evaluations/${id}`,
            {
              method: 'PUT',
              body,
            },
          );
          rowVersion.current = result.evaluation.rowVersion;
          attempt.current = 0;
          savedRef.current = snap(sending);
          setSaved(savedRef.current);
          onSavedRef.current(result.evaluation);
          if (snap(latest.current) === savedRef.current) {
            clearBackup(id);
            setState({ kind: 'saved' });
          } else {
            setState({ kind: 'pending' });
          }
          return true;
        } catch (e) {
          if (e instanceof ApiError && e.code === EVALUATION_ERRORS.EVALUATION_CONFLICT) {
            stopped.current = true;
            const server = (e.details as { evaluation?: EvaluationDetail } | undefined)?.evaluation;
            if (server) setState({ kind: 'conflict', server });
            else setState({ kind: 'failed', message: e.message });
            return false;
          }
          const retryable = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
          if (retryable && attempt.current < RETRY_DELAYS_MS.length) {
            const delay = RETRY_DELAYS_MS[attempt.current]!;
            attempt.current += 1;
            setState({
              kind: 'retrying',
              message: e instanceof Error ? e.message : 'The save failed.',
              attempt: attempt.current,
            });
            clearTimer();
            timer.current = setTimeout(() => void save(), delay);
          } else {
            if (!retryable) stopped.current = true;
            setState({
              kind: 'failed',
              message: e instanceof Error ? e.message : 'The save failed.',
            });
          }
          return false;
        } finally {
          inFlight.current = null;
        }
      })();
      inFlight.current = run;
      return run;
    },
    [id],
  );

  const setInput = useCallback(
    (next: EvaluationInput) => {
      latest.current = next;
      setInputState(next);
      writeBackup(id, {
        rowVersion: rowVersion.current,
        input: next,
        savedAt: new Date().toISOString(),
      });
      if (stopped.current) return;
      setState((s) => (s.kind === 'saving' || s.kind === 'retrying' ? s : { kind: 'pending' }));
      clearTimer();
      timer.current = setTimeout(() => void doSave(), AUTOSAVE_DELAY_MS);
    },
    [id, doSave],
  );

  /** Saves now (the Save button, or before submitting). Resolves true when everything is saved. */
  const saveNow = useCallback(async () => {
    clearTimer();
    attempt.current = 0;
    if (stopped.current) return false;
    if (snap(latest.current) === savedRef.current && !inFlight.current) return true;
    const ok = await doSave();
    if (ok && snap(latest.current) !== savedRef.current) return doSave();
    return ok;
  }, [doSave]);

  /** Conflict: take what is stored on the server and drop the changes made here. */
  const takeServerVersion = useCallback(
    (server: EvaluationDetail) => {
      stopped.current = false;
      clearTimer();
      rowVersion.current = server.rowVersion;
      const next = inputOf(server);
      latest.current = next;
      savedRef.current = snap(next);
      setInputState(next);
      setSaved(savedRef.current);
      clearBackup(id);
      onSavedRef.current(server);
      setState({ kind: 'saved' });
    },
    [id],
  );

  /** Conflict: keep the changes made here and save them over the stored version, on purpose. */
  const keepMine = useCallback(
    async (server: EvaluationDetail) => {
      stopped.current = false;
      rowVersion.current = server.rowVersion;
      savedRef.current = snap(inputOf(server));
      setSaved(savedRef.current);
      return saveNow();
    },
    [saveNow],
  );

  /** Puts back values from this device's backup (they still need saving). */
  const restore = useCallback(
    (backup: EvaluationInput) => {
      setInput(backup);
    },
    [setInput],
  );

  /** The row version the next save or submit must name. */
  const currentRowVersion = useCallback(() => rowVersion.current, []);

  useEffect(() => () => clearTimer(), []);

  return {
    input,
    setInput,
    state,
    dirty,
    saveNow,
    takeServerVersion,
    keepMine,
    restore,
    currentRowVersion,
  };
}
