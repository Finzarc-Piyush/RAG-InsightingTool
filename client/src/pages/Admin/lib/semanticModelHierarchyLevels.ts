/**
 * Wave W61-hierarchy-edit · pure helpers for the `SemanticHierarchy.levels`
 * editor modal. The editor opens against the existing W61-save PATCH
 * path (no dedicated hierarchy endpoint) — the host builds the next
 * `SemanticModel` with the edited hierarchy's `levels` array replaced
 * and calls `patchSemanticModel(sessionId, nextModel)`.
 *
 * The helpers cover the four mutation operations the modal needs
 * (move-up / move-down / remove / append / set-at), the per-level +
 * cross-level validation (snake_case + length + duplicate detection +
 * min/max-levels bounds), and the level-name validator that mirrors
 * the server's `semanticHierarchySchema.levels` element validator.
 *
 * Server schema reference: [server/shared/schema.ts:992-1001](../../../../server/shared/schema.ts) —
 *   levels: z.array(z.string().min(1).max(80).regex(SNAKE_CASE)).min(2).max(8)
 *
 * Drift between this client-side validator and the server's
 * `safeParse` is correctness-preserving — an invalid level the client
 * misses round-trips to a 400 from W61-save, which the host's
 * existing PATCH error path surfaces. Same precedent as
 * `validateName` in W61-add-client (W61-add-client mirrors the
 * server's name regex; this wave mirrors the server's levels regex
 * with the additional duplicate-detection check the schema doesn't
 * enforce but the modal can usefully surface inline).
 */

/** Server: `z.string().min(1).max(80).regex(SNAKE_CASE)` on each level. */
export const SNAKE_CASE_LEVEL_RE = /^[a-z][a-z0-9_]*$/;
export const MAX_LEVEL_NAME_LENGTH = 80;

/** Server: `z.array(...).min(2).max(8)`. */
export const MIN_LEVELS = 2;
export const MAX_LEVELS = 8;

/**
 * Validate a single level-name string. Returns `null` on valid, or a
 * short user-facing error string suitable for inline display under
 * the input cell.
 *
 * Mirrors `validateName` from `semanticModelEditValidation.ts` —
 * snake_case + length bounds + non-empty check.
 */
export function validateLevelName(value: string): string | null {
  if (!value || !value.trim()) return "Level name is required";
  if (value.length > MAX_LEVEL_NAME_LENGTH) {
    return `Level name must be ${MAX_LEVEL_NAME_LENGTH} characters or fewer`;
  }
  if (!SNAKE_CASE_LEVEL_RE.test(value)) {
    return "snake_case only — lowercase letters, digits, underscores (start with a letter)";
  }
  return null;
}

/** Per-level + global validation result for the editor modal. */
export interface LevelValidationResult {
  /** One entry per level — `null` for valid, a string for the inline error. */
  perLevel: Array<string | null>;
  /** Single global error (count out of range) — `null` when within bounds. */
  global: string | null;
  /** True iff every per-level entry is null AND global is null. */
  valid: boolean;
}

/**
 * Validate a full ordered list of level names. Surfaces:
 *   - per-level snake_case / length / non-empty errors;
 *   - duplicate-level errors (a level can't be referenced twice in
 *     the same hierarchy — the server schema doesn't enforce this
 *     but it's a real bug if it lands in a saved model);
 *   - global "must have 2-8 levels" out-of-bounds error.
 *
 * The duplicate-detection rule is applied AFTER the per-level
 * validity check so a malformed level (e.g. PascalCase) surfaces the
 * format error rather than a less-actionable "duplicate" error if
 * the same malformed string appears twice.
 */
export function validateLevels(levels: readonly string[]): LevelValidationResult {
  const perLevel: Array<string | null> = levels.map(validateLevelName);
  // Count occurrences for the duplicate check. Use the raw string —
  // a future case-insensitive normalisation would normalise here.
  const counts = new Map<string, number>();
  for (const l of levels) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (let i = 0; i < levels.length; i += 1) {
    if (perLevel[i] === null && (counts.get(levels[i]) ?? 0) > 1) {
      perLevel[i] = "Duplicate level — already in this hierarchy";
    }
  }
  let global: string | null = null;
  if (levels.length < MIN_LEVELS) {
    global = `Hierarchy must have at least ${MIN_LEVELS} levels`;
  } else if (levels.length > MAX_LEVELS) {
    global = `Hierarchy must have at most ${MAX_LEVELS} levels`;
  }
  return {
    perLevel,
    global,
    valid: global === null && perLevel.every((e) => e === null),
  };
}

/**
 * Swap levels[idx-1] and levels[idx]. Returns a fresh array; idempotent
 * no-op (returns a shallow copy) when idx is out of range.
 */
export function moveLevelUp(levels: readonly string[], idx: number): string[] {
  if (idx <= 0 || idx >= levels.length) return levels.slice();
  const next = levels.slice();
  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
  return next;
}

/**
 * Swap levels[idx] and levels[idx+1]. Returns a fresh array; idempotent
 * no-op when idx is out of range or at the last position.
 */
export function moveLevelDown(levels: readonly string[], idx: number): string[] {
  if (idx < 0 || idx >= levels.length - 1) return levels.slice();
  const next = levels.slice();
  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
  return next;
}

/** Remove the level at the given position. No-op on out-of-range idx. */
export function removeLevel(levels: readonly string[], idx: number): string[] {
  if (idx < 0 || idx >= levels.length) return levels.slice();
  return [...levels.slice(0, idx), ...levels.slice(idx + 1)];
}

/** Append a new level to the end. Caller validates the value first. */
export function appendLevel(levels: readonly string[], value: string): string[] {
  return [...levels, value];
}

/** Replace the level at the given position. No-op on out-of-range idx. */
export function setLevelAt(
  levels: readonly string[],
  idx: number,
  value: string,
): string[] {
  if (idx < 0 || idx >= levels.length) return levels.slice();
  const next = levels.slice();
  next[idx] = value;
  return next;
}

/**
 * Build the headline for the editor modal. Encodes the hierarchy's
 * human-readable `label` (not its snake_case `name`) so the admin
 * sees what they're editing in business terms.
 */
export function buildHierarchyEditHeadline(label: string): string {
  return `Edit levels for ${label}`;
}

/**
 * Build the submit-button label. Idle / submitting pair matching the
 * W61-add-client `buildAddSubmitLabel` shape (U+2026 ellipsis on
 * submitting so the visual indicator is consistent across the W61
 * modal family).
 */
export function buildHierarchyEditSubmitLabel(submitting: boolean): string {
  return submitting ? "Saving…" : "Save levels";
}
