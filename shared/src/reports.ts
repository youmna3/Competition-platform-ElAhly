export const REPORT_KINDS = [
  'results',
  'evaluations',
  'progress',
  'corrections',
  'rubrics',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export interface ReportFilters {
  teamId?: number;
  judgeId?: number;
  version?: number;
  status?: 'draft' | 'submitted';
  from?: string;
  to?: string;
}
export const REPORT_LABELS: Record<ReportKind, string> = {
  results: 'Competition Results',
  evaluations: 'Individual Judge Evaluations',
  progress: 'Judging Progress',
  corrections: 'Admin Corrections',
  rubrics: 'Rubric History',
};
export type ReportCell = string | number | boolean | null;
export interface ReportSheet {
  name: string;
  columns: string[];
  rows: ReportCell[][];
}
export interface ReportWorkbook {
  kind: ReportKind;
  generatedAt: string;
  filters: ReportFilters;
  sheets: ReportSheet[];
}
