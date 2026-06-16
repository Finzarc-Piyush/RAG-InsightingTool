/**
 * Standard response envelope helpers.
 *
 * API-4 · Convention for NEW endpoints — wrap success payloads in
 * `{ data, meta? }` and error payloads in `{ error: { code, message, details? } }`.
 * This gives external consumers one predictable shape (a `data` field on
 * success, an `error` object on failure) instead of guessing per-route.
 *
 * SCOPE — this convention is for **new** endpoints only. The existing routes in
 * this codebase return bespoke shapes the client already depends on (e.g.
 * `{ sessions, count }`, `{ dashboards }`, raw documents). We do NOT rewrap
 * those — doing so would be a breaking change. Use these helpers when you add a
 * brand-new endpoint and want it to follow the canonical contract.
 *
 * @example
 *   // success
 *   res.json(ok(rows, { page, limit, total }));
 *   // => { data: rows, meta: { page, limit, total } }
 *
 *   // failure
 *   res.status(404).json(fail("not_found", "Dashboard not found"));
 *   // => { error: { code: "not_found", message: "Dashboard not found" } }
 */

export interface SuccessEnvelope<T, M = unknown> {
  data: T;
  meta?: M;
}

export interface ErrorEnvelope<D = unknown> {
  error: {
    /** Stable, machine-readable code (snake_case) — clients branch on this. */
    code: string;
    /** Human-readable message safe to surface in a UI. */
    message: string;
    /** Optional structured context (validation issues, ids, etc.). */
    details?: D;
  };
}

/** Wrap a success payload as `{ data, meta? }`. */
export function ok<T, M = unknown>(data: T, meta?: M): SuccessEnvelope<T, M> {
  return meta === undefined ? { data } : { data, meta };
}

/** Wrap an error as `{ error: { code, message, details? } }`. */
export function fail<D = unknown>(
  code: string,
  message: string,
  details?: D,
): ErrorEnvelope<D> {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}
