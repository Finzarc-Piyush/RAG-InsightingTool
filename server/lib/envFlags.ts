/**
 * ============================================================================
 * envFlags.ts — ONE place to parse environment feature flags + numeric knobs
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Tiny, dependency-free helpers for reading `process.env`. Two concerns that
 *   were previously hand-coded (with subtle divergence) in many config files:
 *     - `envInt(value, default)` — the integer-knob parser that was copy-pasted
 *       verbatim as a local `num()` in diagnosticPipelineConfig, investigationTree
 *       (twice) and types.ts.
 *     - boolean flag truthiness — `envFlagOn` (default-OFF) and
 *       `envFlagEnabledByDefault` (default-ON), both case-insensitive, so a flag
 *       set to `False` / `OFF` behaves the same on every read path.
 *
 * WHY IT MATTERS
 *   `BUSINESS_ACTIONS_ENABLED` was read case-INSENSITIVELY in the live loop but
 *   case-SENSITIVELY in the replay loop, so `BUSINESS_ACTIONS_ENABLED=False`
 *   silently disabled business actions on live turns but NOT on replayed ones —
 *   an inconsistent-results bug. Centralising the parse kills that class of fork.
 *
 * HOW IT CONNECTS
 *   Pure module (no imports). Import these instead of re-deriving truthiness or
 *   re-cloning the int parser.
 */

/**
 * Parse an integer env knob, falling back to `fallback` when unset or
 * non-numeric. (Consolidates the `num()` helper formerly cloned across
 * diagnosticPipelineConfig / investigationTree / types.)
 */
export function envInt(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Truthiness for a DEFAULT-OFF flag: ON iff the value is one of
 * `1 / true / yes / on` (case-insensitive, whitespace-trimmed). Anything else —
 * including unset — is OFF.
 */
export function envFlagOn(value: string | undefined): boolean {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Truthiness for a DEFAULT-ON flag: OFF iff the value is one of
 * `0 / false / no / off` (case-insensitive, whitespace-trimmed). Unset is ON.
 */
export function envFlagEnabledByDefault(value: string | undefined): boolean {
  if (value == null) return true;
  const v = value.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * `BUSINESS_ACTIONS_ENABLED` — default ON, case-insensitive. THE single accessor
 * so the live agent loop and the replay loop can never disagree on whether
 * business actions run (they previously diverged on case-sensitivity).
 */
export function isBusinessActionsEnabled(): boolean {
  return envFlagEnabledByDefault(process.env.BUSINESS_ACTIONS_ENABLED);
}
