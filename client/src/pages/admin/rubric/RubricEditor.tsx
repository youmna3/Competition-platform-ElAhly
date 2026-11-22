import { useId } from 'react';
import { RUBRIC_LIMITS as L, totalWeight, type RubricContent } from '@judging/shared';
import { StarRating } from '../../../components/StarRating';
import { Card } from '../../../components/ui';
import type { EditCriterion, EditRubric, EditSection } from './model';

const inputClass =
  'block w-full rounded-xl border border-black/15 bg-white px-3.5 py-2.5 text-base shadow-sm outline-none transition placeholder:text-black/35 focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 aria-[invalid=true]:border-ahly-red sm:text-sm';

function Field({
  label,
  hint,
  error,
  path,
  value,
  onChange,
  multiline,
  rows = 3,
  maxLength,
  placeholder,
}: {
  label: string;
  hint?: string;
  error?: string;
  path: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  rows?: number;
  maxLength: number;
  placeholder?: string;
}) {
  const id = useId();
  const common = {
    id,
    'data-path': path,
    value,
    placeholder,
    maxLength,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-e` : hint ? `${id}-h` : undefined,
    className: inputClass,
  };
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {multiline ? (
        <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type="text" onChange={(e) => onChange(e.target.value)} />
      )}
      {error ? (
        <p id={`${id}-e`} className="text-xs font-medium text-ahly-red-dark">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-h`} className="text-xs text-black/55">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Slider plus number box for one section's percentage. */
function WeightControl({
  section,
  index,
  onChange,
  error,
}: {
  section: EditSection;
  index: number;
  onChange: (value: string) => void;
  error?: string;
}) {
  const id = useId();
  const numeric = Number(section.weightPercent);
  const sliderValue =
    section.weightPercent.trim() !== '' && Number.isFinite(numeric)
      ? Math.max(0, Math.min(100, numeric))
      : 0;
  const name = section.title.trim() || `Section ${index + 1}`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold">
          {index + 1}. {name}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id={id}
            data-path={`sections.${index}.weightPercent`}
            type="text"
            inputMode="numeric"
            maxLength={3}
            value={section.weightPercent}
            placeholder="—"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-e` : undefined}
            onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
            className="w-16 rounded-lg border border-black/15 px-2 py-1.5 text-right text-sm font-semibold shadow-sm outline-none focus:border-ischool-blue focus:ring-4 focus:ring-ischool-blue/15 aria-[invalid=true]:border-ahly-red"
          />
          <span className="text-sm font-semibold">%</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={sliderValue}
        aria-label={`${name} weight`}
        aria-valuetext={section.weightPercent ? `${section.weightPercent}%` : 'not set'}
        onChange={(e) => onChange(e.target.value === '0' ? '' : e.target.value)}
        className="w-full accent-ahly-red"
      />
      {error && (
        <p id={`${id}-e`} className="text-xs font-medium text-ahly-red-dark">
          {error}
        </p>
      )}
    </div>
  );
}

export function RubricEditor({
  value,
  onChange,
  errors,
  content,
}: {
  value: EditRubric;
  onChange: (next: EditRubric) => void;
  /** Field-level problems that block saving, keyed by path. */
  errors: Map<string, string>;
  /** The same rubric with numbers parsed, for the live total. */
  content: RubricContent;
}) {
  const set = (patch: Partial<EditRubric>) => onChange({ ...value, ...patch });
  const setSection = (i: number, patch: Partial<EditSection>) =>
    set({ sections: value.sections.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const setCriterion = (i: number, j: number, patch: Partial<EditCriterion>) =>
    setSection(i, {
      criteria: value.sections[i]!.criteria.map((c, k) => (k === j ? { ...c, ...patch } : c)),
    });

  const total = totalWeight(
    content.sections.map((s) => ({
      weightPercent: Number.isFinite(s.weightPercent) ? s.weightPercent : 0,
    })),
  );
  const totalOk = total === 100;

  return (
    <div className="space-y-6">
      <Card className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">1. Rubric details</h2>
          <p className="text-sm text-black/55">Judges see these at the top of the rubric.</p>
        </div>
        <Field
          label="Rubric title"
          path="title"
          value={value.title}
          onChange={(title) => set({ title })}
          maxLength={L.title}
          error={errors.get('title')}
          placeholder="For example: iSchool × Al Ahly Final Judging Rubric"
        />
        <Field
          label="Description (optional)"
          path="description"
          value={value.description}
          onChange={(description) => set({ description })}
          multiline
          rows={2}
          maxLength={L.description}
          error={errors.get('description')}
        />
        <Field
          label="Instructions for judges (optional)"
          hint="How judges should approach rating. Shown on the rubric and, from Phase 6, on the scoring form."
          path="instructions"
          value={value.instructions}
          onChange={(instructions) => set({ instructions })}
          multiline
          rows={4}
          maxLength={L.instructions}
          error={errors.get('instructions')}
        />
      </Card>

      <Card className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold">2. Section weights</h2>
          <p className="text-sm text-black/55">
            How much each section counts toward the final score out of 100. The two criteria in a
            section count equally.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {value.sections.map((s, i) => (
            <WeightControl
              key={s.key}
              section={s}
              index={i}
              onChange={(weightPercent) => setSection(i, { weightPercent })}
              error={errors.get(`sections.${i}.weightPercent`)}
            />
          ))}
        </div>
        <div
          data-path="weights"
          tabIndex={-1}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-3 ${totalOk ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-ahly-red-dark'}`}
          role="status"
          aria-live="polite"
        >
          <span className="font-semibold">Total weight</span>
          <span className="text-lg font-bold tabular-nums">{total}% / 100%</span>
          {!totalOk && (
            <span className="w-full text-xs">
              The section percentages must total 100% before publishing (
              {total < 100 ? `${100 - total}% left to assign` : `${total - 100}% too much`}).
            </span>
          )}
        </div>
      </Card>

      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">3. Sections and criteria</h2>
          <p className="text-sm text-black/55">
            The rubric always has 4 sections with 2 criteria each. Judges rate every criterion from
            1 to 5 stars.
          </p>
        </div>
        {value.sections.map((s, i) => (
          <Card key={s.key} className="space-y-4 !p-0">
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 bg-black/[0.015] px-5 py-3 sm:px-6"
              data-path={`sections.${i}`}
              tabIndex={-1}
            >
              <p className="text-sm font-semibold">
                Section {i + 1}
                {s.title.trim() && <span className="font-normal text-black/60"> · {s.title}</span>}
              </p>
              <span className="rounded-full bg-ahly-red/10 px-3 py-0.5 text-sm font-semibold text-ahly-red-dark">
                {s.weightPercent ? `${s.weightPercent}% of the score` : 'Weight not set'}
              </span>
            </div>
            <div className="space-y-4 px-5 sm:px-6">
              <Field
                label="Section title"
                path={`sections.${i}.title`}
                value={s.title}
                maxLength={L.sectionTitle}
                onChange={(title) => setSection(i, { title })}
                error={errors.get(`sections.${i}.title`)}
              />
              <Field
                label="Section description (optional)"
                path={`sections.${i}.description`}
                value={s.description}
                multiline
                rows={2}
                maxLength={L.sectionDescription}
                onChange={(description) => setSection(i, { description })}
                error={errors.get(`sections.${i}.description`)}
              />
            </div>
            <div className="grid gap-4 px-5 pb-5 sm:px-6 lg:grid-cols-2">
              {s.criteria.map((c, j) => {
                const cp = `sections.${i}.criteria.${j}`;
                return (
                  <div key={c.key} className="space-y-3 rounded-xl border border-black/10 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold">
                        Criterion {i + 1}.{j + 1}
                      </p>
                      <StarRating label={`Criterion ${i + 1}.${j + 1}`} size={18} />
                    </div>
                    <Field
                      label="Criterion title"
                      path={`${cp}.title`}
                      value={c.title}
                      maxLength={L.criterionTitle}
                      onChange={(title) => setCriterion(i, j, { title })}
                      error={errors.get(`${cp}.title`)}
                    />
                    <Field
                      label="Description (optional)"
                      hint="What this criterion is about."
                      path={`${cp}.description`}
                      value={c.description}
                      multiline
                      rows={2}
                      maxLength={L.criterionDescription}
                      onChange={(description) => setCriterion(i, j, { description })}
                      error={errors.get(`${cp}.description`)}
                    />
                    <Field
                      label="Judging guidelines (optional)"
                      hint="What 1 to 5 stars look like for this criterion."
                      path={`${cp}.guidelines`}
                      value={c.guidelines}
                      multiline
                      rows={2}
                      maxLength={L.guidelines}
                      onChange={(guidelines) => setCriterion(i, j, { guidelines })}
                      error={errors.get(`${cp}.guidelines`)}
                    />
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
