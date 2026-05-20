/**
 * W61-edit-text · Per-field validators for inline editing of the
 * admin semantic-model viewer.
 *
 * The server PATCH endpoint (W61-save) validates the whole body via
 * `semanticModelSchema.safeParse` and is authoritative — these
 * client-side validators just keep obviously-broken inputs from
 * round-tripping at all. Better UX (instant red border vs. wait for
 * a 400), fewer wasted PATCH calls, and the W58 compiler still
 * decides whether an aggregation actually binds against the dataset.
 *
 * Each validator returns `null` on valid, or a short error message
 * suitable for inline display under the input.
 *
 * Bounds mirror `semanticMetricSchema` / `semanticDimensionSchema`
 * in [server/shared/schema.ts](../../../../../server/shared/schema.ts).
 * If the schema bounds change, update these to match — drift here
 * just means a save attempt round-trips to the server for the real
 * rejection, not a correctness bug.
 */

const LABEL_MIN = 1;
const LABEL_MAX = 120;
const DESCRIPTION_MAX = 1000;
const EXPRESSION_MIN = 1;
const EXPRESSION_MAX = 2000;

export function validateLabel(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < LABEL_MIN) return "Label is required";
  if (trimmed.length > LABEL_MAX) {
    return `Label must be ${LABEL_MAX} characters or fewer`;
  }
  return null;
}

export function validateDescription(value: string): string | null {
  if (value.length > DESCRIPTION_MAX) {
    return `Description must be ${DESCRIPTION_MAX} characters or fewer`;
  }
  return null;
}

/**
 * Pure aggregation expression — `SUM(col)`, `AVG(col)`, ratios via
 * NULLIF, etc. Rejects:
 *   - empty / too long
 *   - semicolons (would let an admin chain a SELECT after the expr)
 *   - SQL comments (`--` or `/*`) — they hide content from the W58
 *     compiler validation, e.g. `SUM(x) -- )` could mask a paren imbalance
 *   - top-level SELECT / FROM / JOIN / WHERE / GROUP BY / ORDER BY /
 *     UNION keywords — the field is an aggregation, not a sub-query
 *
 * The W58 compiler does the authoritative parse and column-binding
 * check; this is the cheap obvious-broken filter that catches paste
 * accidents (admin copies a full SELECT statement from a notebook).
 */
export function validateExpression(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < EXPRESSION_MIN) return "Expression is required";
  if (trimmed.length > EXPRESSION_MAX) {
    return `Expression must be ${EXPRESSION_MAX} characters or fewer`;
  }
  if (trimmed.includes(";")) {
    return "No semicolons — expression must be a single aggregation";
  }
  if (trimmed.includes("--") || trimmed.includes("/*")) {
    return "No SQL comments inside the expression";
  }
  const padded = ` ${trimmed.toUpperCase()} `;
  const BANNED: ReadonlyArray<string> = [
    " SELECT ",
    " FROM ",
    " JOIN ",
    " WHERE ",
    " GROUP BY ",
    " ORDER BY ",
    " UNION ",
  ];
  for (const kw of BANNED) {
    if (padded.includes(kw)) {
      const display = kw.trim();
      return `No "${display}" keyword — paste only the aggregation (e.g. SUM(col))`;
    }
  }
  return null;
}

/**
 * Returns true when the trimmed candidate differs from the prior
 * value — used by inline-edit save handlers to skip a no-op PATCH
 * when the user blurs without making a change.
 */
export function isMeaningfulChange(prior: string, next: string): boolean {
  return prior.trim() !== next.trim();
}
