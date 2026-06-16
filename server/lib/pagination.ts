/**
 * Shared pagination parser for REST endpoints.
 *
 * API-6 · A single place that turns raw `req.query` into a safe, clamped
 * `{ page, limit }` pair. Endpoints historically each did their own
 * `parseInt(req.query.page) || 1`, which let a caller pass `limit=999999999`
 * (a memory / latency footgun) or `page=-3` (an out-of-range slice). This
 * normaliser clamps both into a sane window so every adopting endpoint is
 * protected uniformly.
 *
 * IMPORTANT — this only normalises the INPUTS. It deliberately does NOT impose
 * an output field-name convention: existing endpoints keep returning whatever
 * field names their clients already read (`pagination.totalRows`, etc.). New
 * endpoints may shape their own response using {@link PaginatedResult}.
 */

/** Express-style query bag — values are string | string[] | undefined. */
export type RawQuery = Record<string, unknown>;

export interface ParsePaginationOptions {
  /** Hard ceiling on `limit`. Required so each endpoint picks its own cap. */
  maxLimit: number;
  /** Fallback `limit` when the caller omits/garbles it. Defaults to `maxLimit`. */
  defaultLimit?: number;
}

export interface Pagination {
  /** 1-based page index, clamped to `>= 1`. */
  page: number;
  /** Page size, clamped into `[1, maxLimit]`. */
  limit: number;
  /** Zero-based row offset derived from `(page - 1) * limit`. */
  offset: number;
}

/** A page of rows plus the cursor/metadata that produced it. */
export interface PaginatedResult<T> {
  items: T[];
  page: number;
  limit: number;
  /** Total rows across all pages, when the source can count cheaply. */
  total?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
}

/** Coerce one query value (which may be a string[]) into a finite integer. */
function toInt(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse + clamp pagination params from a query bag. Accepts the common aliases
 * (`limit` / `pageSize` / `per_page`) and normalises to a canonical shape.
 *
 * - `page` is clamped to `>= 1` (a missing/garbled value becomes 1).
 * - `limit` is clamped into `[1, maxLimit]` (missing/garbled → `defaultLimit`).
 */
export function parsePagination(
  query: RawQuery | undefined,
  options: ParsePaginationOptions,
): Pagination {
  const q = query ?? {};
  const maxLimit = Math.max(1, Math.floor(options.maxLimit));
  const defaultLimit = Math.min(
    maxLimit,
    Math.max(1, Math.floor(options.defaultLimit ?? maxLimit)),
  );

  const rawPage = toInt(q.page);
  const page = rawPage === undefined ? 1 : Math.max(1, rawPage);

  const rawLimit =
    toInt(q.limit) ?? toInt(q.pageSize) ?? toInt(q.per_page);
  const limit =
    rawLimit === undefined
      ? defaultLimit
      : Math.min(maxLimit, Math.max(1, rawLimit));

  return { page, limit, offset: (page - 1) * limit };
}
