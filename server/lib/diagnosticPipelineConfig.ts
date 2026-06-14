/**
 * Feature flags and thresholds for diagnostic ("deep dive") analysis rollout.
 * Defaults preserve existing behavior until flags are enabled.
 */

// Truthiness + int parsing live in the shared envFlags helper so every config
// file reads flags identically (case-insensitive). See lib/envFlags.ts.
import { envFlagOn, envInt } from "./envFlags.js";

const truthy = envFlagOn;
const num = envInt;

/** When true, merge parser dimensionFilters into intermediate SSE pivotDefaults (gated by confidence + diagnostic scope). */
export function isDiagnosticPivotFilterMergeEnabled(): boolean {
  return truthy(process.env.DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED);
}

/** Master switch for composite segment driver tool registration and execution. */
export function isDiagnosticCompositeToolEnabled(): boolean {
  return truthy(process.env.DIAGNOSTIC_COMPOSITE_TOOL_ENABLED);
}

/** Minimum parseUserQuery confidence (0–1) to merge filters into intermediate pivots. */
export function diagnosticPivotMergeMinConfidence(): number {
  const v = process.env.DIAGNOSTIC_PIVOT_MERGE_MIN_CONFIDENCE;
  if (v == null || v === "") return 0.75;
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.75;
}

/** Max rows read from turn-start frame for diagnostic filtering / correlation (soft cap). */
export function diagnosticSliceRowCap(): number {
  return num(process.env.DIAGNOSTIC_SLICE_ROW_CAP, 100_000);
}

/** Max parallel branches inside run_segment_driver_analysis. */
export function diagnosticMaxParallelBranches(): number {
  return Math.min(8, Math.max(1, num(process.env.DIAGNOSTIC_MAX_PARALLEL, 3)));
}

// isDeepInvestigationEnabled lives in investigationTree.ts (its natural home,
// where the deep-investigation tests import it). The byte-for-byte duplicate
// that used to sit here was removed.
