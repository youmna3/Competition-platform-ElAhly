/** Password rules for every account. Used by the seed script now and by sign-in screens later. */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_POLICY_TEXT =
  `At least ${PASSWORD_MIN_LENGTH} characters, with an upper-case letter, a lower-case letter, ` +
  'a number and a symbol.';

/**
 * Returns a list of problems; an empty list means the password is acceptable.
 * Pass the account's e-mail to also refuse passwords that contain it.
 */
export function passwordProblems(password: string, context: { email?: string } = {}): string[] {
  const problems: string[] = [];
  const localPart = context.email?.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    problems.push('must not contain your e-mail name');
  }
  if (password.length < PASSWORD_MIN_LENGTH)
    problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH)
    problems.push(`must be at most ${PASSWORD_MAX_LENGTH} characters`);
  if (!/[a-z]/.test(password)) problems.push('needs a lower-case letter');
  if (!/[A-Z]/.test(password)) problems.push('needs an upper-case letter');
  if (!/\d/.test(password)) problems.push('needs a number');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('needs a symbol');
  if (/^\s|\s$/.test(password)) problems.push('must not start or end with a space');
  return problems;
}
