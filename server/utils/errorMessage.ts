/**
 * CQ-6 · One definition of the "get a string message from an unknown error"
 * pattern that was copy-pasted ~131 times as
 * `e instanceof Error ? e.message : String(e)`.
 *
 * Use in catch blocks: `catch (e) { logger.error(errorMessage(e)); }`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
