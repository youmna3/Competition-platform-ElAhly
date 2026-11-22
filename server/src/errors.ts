/** A business-rule violation the API turns into a clear 4xx JSON response. */
export class RuleError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Extra JSON merged into the response body (for example row-level import errors). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RuleError';
  }
}
