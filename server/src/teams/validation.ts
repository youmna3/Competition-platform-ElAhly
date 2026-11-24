import { z } from 'zod';
import { TEAM_CODE_PATTERN, TEAM_LIMITS } from '@judging/shared';

const noControlChars = (v: string) => !/[\p{Cc}<>]/u.test(v);

export const studentNamesSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, 'Enter each student’s full name.')
      .max(TEAM_LIMITS.studentName)
      .refine(noControlChars, 'Student name contains characters that are not allowed.'),
  )
  .min(2, 'Add at least two students.')
  .max(3, 'A team can have at most three students.');
export const teamLinkSchema = z
  .string()
  .trim()
  .max(TEAM_LIMITS.link)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !/[\p{Cc}<>]/u.test(value)
      );
    } catch {
      return false;
    }
  }, 'Enter a complete HTTP or HTTPS link without embedded credentials.')
  .transform((v) => v || null)
  .nullable();
export const teamResourceShape = {
  studentNames: studentNamesSchema.optional(),
  presentationLink: teamLinkSchema.optional(),
  projectWebsiteLink: teamLinkSchema.optional(),
};

export const teamCodeSchema = z
  .string({ message: 'Team ID is required.' })
  .trim()
  .min(1, { message: 'Team ID is required.', abort: true })
  .max(TEAM_LIMITS.code, `Team ID can be at most ${TEAM_LIMITS.code} characters.`)
  .regex(
    TEAM_CODE_PATTERN,
    'Team ID may only contain letters, numbers, spaces and - _ . / #, and must start with a letter or number.',
  );

export const teamNameSchema = z
  .string({ message: 'Team name is required.' })
  .trim()
  .min(1, { message: 'Team name is required.', abort: true })
  .max(TEAM_LIMITS.name, `Team name can be at most ${TEAM_LIMITS.name} characters.`)
  .refine(noControlChars, 'Team name contains characters that are not allowed.');

export const projectNameSchema = z
  .string({ message: 'Project name is required.' })
  .trim()
  .min(1, { message: 'Project name is required.', abort: true })
  .max(TEAM_LIMITS.project, `Project name can be at most ${TEAM_LIMITS.project} characters.`)
  .refine(noControlChars, 'Project name contains characters that are not allowed.');

export const teamInputSchema = z
  .object({
    teamCode: teamCodeSchema,
    name: teamNameSchema,
    projectName: projectNameSchema,
    ...teamResourceShape,
  })
  .strict();

export const teamUpdateSchema = z
  .object({
    teamCode: teamCodeSchema.optional(),
    name: teamNameSchema.optional(),
    projectName: projectNameSchema.optional(),
    ...teamResourceShape,
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change.');

export type ValidTeamInput = z.infer<typeof teamInputSchema>;

/** Field-by-field messages for one import row (server re-checks every row). */
export function importRowErrors(row: Record<string, unknown>): string[] {
  const result = teamInputSchema.safeParse({
    teamCode: row.teamCode ?? '',
    name: row.name ?? '',
    projectName: row.projectName ?? '',
    studentNames: row.studentNames,
    presentationLink: row.presentationLink,
    projectWebsiteLink: row.projectWebsiteLink,
  });
  return result.success ? [] : result.error.issues.map((i) => i.message);
}
