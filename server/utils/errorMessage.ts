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

/**
 * TYPE-7 · Narrow an `unknown` caught error to a string `code` when present
 * (Node system errors, Cosmos/Azure SDK errors, and many libraries attach a
 * string/number `code`). Returns `undefined` when absent. This is the typed
 * replacement for the `catch (e: any) { … e.code … }` pattern: catch as
 * `unknown`, then `getErrorCode(e)` instead of reaching through `any`.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (typeof code === "number") return String(code);
  }
  return undefined;
}

/**
 * TYPE-7 · Narrow an `unknown` caught error to a numeric HTTP-ish `status` /
 * `statusCode` when present (Axios, Cosmos, node-fetch wrappers). Returns
 * `undefined` when absent.
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}
