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

/**
 * W61-edit-enums · ISO 4217 currency code — three uppercase letters
 * (USD, INR, EUR…). Required by `semanticMetricSchema` when
 * `format === "currency"`; declared `.optional()` so the empty
 * string is a legitimate "not set yet" value while the admin is
 * mid-edit. The server's `safeParse` is authoritative on the
 * cross-field constraint (`format === "currency"` paired with an
 * empty currencyCode rejects at PATCH time).
 *
 * This validator does NOT enforce the format-coupling — `EditableText`
 * validates fields in isolation; the UI gates the field's
 * visibility on `format === "currency"`.
 */
export function validateCurrencyCode(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^[A-Z]{3}$/.test(trimmed)) {
    return "ISO 4217 (3 uppercase letters, e.g. INR)";
  }
  return null;
}

/**
 * W61-add-client · snake_case identifier for new metric / dimension /
 * hierarchy `name`. Mirrors the server's `SNAKE_CASE` regex in
 * [`semanticMetricSchema`](../../../../../server/shared/schema.ts) —
 * lowercase letter first, then lowercase letters / digits / underscores.
 *
 * Length bounds match `semanticMetricSchema.name.min(1).max(80)` (the
 * three semantic-* schemas share the same bound on `name`). The server
 * is authoritative — drift here just means an invalid name round-trips
 * to a 400 instead of being caught client-side, which is a correctness-
 * preserving inconvenience.
 *
 * Returns `null` on valid or a short error string suitable for inline
 * display under the input. The error message tells the admin what
 * snake_case looks like rather than just naming the rule.
 */
const NAME_MIN = 1;
const NAME_MAX = 80;
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;
export function validateName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < NAME_MIN) return "Name is required";
  if (trimmed.length > NAME_MAX) {
    return `Name must be ${NAME_MAX} characters or fewer`;
  }
  if (!SNAKE_CASE_RE.test(trimmed)) {
    return "snake_case only — lowercase letters, digits, underscores (start with a letter)";
  }
  return null;
}
