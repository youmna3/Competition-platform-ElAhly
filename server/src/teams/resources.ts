import type { TeamResources } from '@judging/shared';

export function teamResources(row: Record<string, unknown>): TeamResources {
  return {
    studentNames: [row.student_name_1, row.student_name_2, row.student_name_3].filter(
      (v): v is string => typeof v === 'string' && !!v,
    ),
    presentationLink: row.presentation_link == null ? null : String(row.presentation_link),
    projectWebsiteLink: row.project_website_link == null ? null : String(row.project_website_link),
  };
}
export const resourceColumns =
  'student_name_1,student_name_2,student_name_3,presentation_link,project_website_link';
export const resourceValues = (input: TeamResources) => [
  input.studentNames?.[0] ?? null,
  input.studentNames?.[1] ?? null,
  input.studentNames?.[2] ?? null,
  input.presentationLink ?? null,
  input.projectWebsiteLink ?? null,
];
