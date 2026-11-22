import type { RubricContent, RubricIssue } from '@judging/shared';

/**
 * The editor keeps the weight as the text the admin typed (so the field can be
 * empty while typing) and gives every row a stable key for React.
 */
export interface EditCriterion {
  key: string;
  title: string;
  description: string;
  guidelines: string;
}

export interface EditSection {
  key: string;
  title: string;
  description: string;
  weightPercent: string;
  criteria: EditCriterion[];
}

export interface EditRubric {
  title: string;
  description: string;
  instructions: string;
  sections: EditSection[];
}

let counter = 0;
export const newKey = () => `k${++counter}`;

export function toEdit(c: RubricContent): EditRubric {
  return {
    title: c.title,
    description: c.description,
    instructions: c.instructions,
    sections: c.sections.map((s) => ({
      key: newKey(),
      title: s.title,
      description: s.description,
      weightPercent: s.weightPercent == null ? '' : String(s.weightPercent),
      criteria: s.criteria.map((cr) => ({
        key: newKey(),
        title: cr.title,
        description: cr.description,
        guidelines: cr.guidelines,
      })),
    })),
  };
}

export function toContent(e: EditRubric): RubricContent {
  return {
    title: e.title,
    description: e.description,
    instructions: e.instructions,
    sections: e.sections.map((s) => ({
      title: s.title,
      description: s.description,
      // Empty means "not set yet"; anything else is checked by validateRubric.
      weightPercent: s.weightPercent.trim() === '' ? null : Number(s.weightPercent),
      criteria: s.criteria.map((c) => ({
        title: c.title,
        description: c.description,
        guidelines: c.guidelines,
      })),
    })),
  };
}

/** Issues keyed by path, for showing messages next to fields. */
export function issueMap(issues: RubricIssue[]) {
  const map = new Map<string, string>();
  for (const i of issues) if (!map.has(i.path)) map.set(i.path, i.message);
  return map;
}

/** Moves focus to the field an issue is about (or the nearest container). */
export function focusPath(path: string) {
  let p = path;
  while (p) {
    const el = document.querySelector<HTMLElement>(`[data-path="${p}"]`);
    if (el) {
      el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
      return;
    }
    p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
  }
}
