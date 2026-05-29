/**
 * Wave W-UD1 · Dataset fingerprint for per-dataset directive scoping.
 *
 * A `UserDirective` (see [shared/schema.ts](../shared/schema.ts)) is scoped to
 * a dataset shape, not to a chat session. Two CSV uploads with the same
 * columns + types share the same fingerprint and therefore inherit each
 * other's persisted directives ("omit Hair Oil from category breakdowns").
 *
 * Hash inputs are intentionally minimal so that:
 *   - column order does NOT affect the fingerprint (sorted)
 *   - row count / file size / filename do NOT affect it
 *   - case differences in column names do NOT affect it (lowercased)
 *   - adding a new column DOES produce a different fingerprint
 *   - changing a column's type DOES produce a different fingerprint
 *
 * The output is a 16-hex-char prefix of sha256 — plenty for the per-user
 * partition scope (collisions within a single user's datasets are
 * astronomically unlikely at that scale).
 */
import { createHash } from "crypto";
import type { DataSummary } from "../shared/schema.js";

const FINGERPRINT_HEX_LENGTH = 16;

/** Lightweight projection of `DataSummary` used as fingerprint input. */
export interface DatasetFingerprintInput {
  columns: ReadonlyArray<{ name: string; type: string }>;
}

/** Normalise + serialise one column entry to its fingerprint contribution. */
function normalizeColumn(col: { name: string; type: string }): string {
  const name = (col.name ?? "").trim().toLowerCase();
  const type = (col.type ?? "").trim().toLowerCase();
  return `${name}::${type}`;
}

/**
 * Compute the dataset fingerprint from a `DataSummary` or any object that
 * carries an array of `{ name, type }` columns. Empty / missing inputs
 * collapse to a stable sentinel so callers don't have to special-case
 * uninitialised summaries.
 */
export function computeDatasetFingerprint(
  input: DatasetFingerprintInput | null | undefined
): string {
  const cols = input?.columns ?? [];
  if (cols.length === 0) {
    return "empty" + "0".repeat(FINGERPRINT_HEX_LENGTH - "empty".length);
  }
  const canonical = cols
    .map(normalizeColumn)
    .filter((entry) => entry.length > "::".length)
    .sort()
    .join("|");
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_LENGTH);
}

/** Convenience overload for a raw `DataSummary`. */
export function fingerprintFromSummary(
  summary: Pick<DataSummary, "columns"> | null | undefined
): string {
  return computeDatasetFingerprint(summary ?? undefined);
}
