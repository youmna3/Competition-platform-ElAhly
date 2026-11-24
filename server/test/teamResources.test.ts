import { describe, expect, it } from 'vitest';
import { teamInputSchema, teamUpdateSchema } from '../src/teams/validation.js';
const base = { teamCode: 'T-1', name: 'Test team', projectName: 'Project' };
describe('team student and resource validation', () => {
  it.each([2, 3])('accepts %i trimmed names', (count) => {
    const names = Array.from({ length: count }, (_, i) => ` Student ${i + 1} `);
    expect(teamInputSchema.parse({ ...base, studentNames: names }).studentNames).toEqual(
      names.map((s) => s.trim()),
    );
  });
  it.each(
    [[], ['Only'], ['A', 'B', 'C', 'D'], ['A', ' '], ['A', '<script>']].map((studentNames) => ({
      studentNames,
    })),
  )('rejects invalid names $studentNames', ({ studentNames }) => {
    expect(teamInputSchema.safeParse({ ...base, studentNames }).success).toBe(false);
  });
  it.each([
    'javascript:alert(1)',
    'file:///secret',
    'https://user:secret@example.com',
    'https://example.com/\nsecret',
    'not a url',
  ])('rejects unsafe links %s', (presentationLink) => {
    expect(teamInputSchema.safeParse({ ...base, presentationLink }).success).toBe(false);
  });
  it('allows optional safe links and legacy requests without removing stored metadata', () => {
    expect(
      teamInputSchema.parse({
        ...base,
        presentationLink: ' https://example.com/slides?q=1 ',
        projectWebsiteLink: '',
      }),
    ).toMatchObject({
      presentationLink: 'https://example.com/slides?q=1',
      projectWebsiteLink: null,
    });
    expect(teamUpdateSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(teamInputSchema.parse(base)).toEqual(base);
  });
});
