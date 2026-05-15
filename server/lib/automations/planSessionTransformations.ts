/**
 * Wave A6 · Plan the schema transformations to apply to a freshly-uploaded
 * dataset BEFORE deterministic recipe replay.
 *
 * Pure function — returns a list of `TransformationStep` objects describing
 * what would happen, without actually doing it. The applier in
 * `replayLoop.service.ts` (Wave A8) consumes this plan, dispatches each
 * step, emits SSE progress events, and stamps results onto the new chat
 * document.
 *
 * Why split? The applier has heavy side-effects (DuckDB rematerialize,
 * blob persist, cache invalidation, summary refresh) — testing it
 * end-to-end requires a live session. The planner is the only piece
 * with non-trivial *decision* logic, and that part deserves its own
 * unit-test coverage.
 *
 * Steps planned:
 *   1. `wide_format_remelt`  — when the saved automation expects long-form
 *      output (wideFormatTransform.detected) AND the new dataset's
 *      auto-detection didn't already produce it. Applier calls
 *      `applyWideFormatMeltIfNeeded` + `applyWideFormatTransformToSummary`
 *      + `saveModifiedData` + `metadataService.invalidate` + DuckDB
 *      rematerialize.
 *   2. `copy_permanent_context` — copies the saved permanentContext onto
 *      the new chat doc.
 *   3. `seed_session_analysis_context` — copies the saved
 *      sessionAnalysisContext seed (slim) onto the new chat doc.
 *
 * NOTE: persisted `add_computed_columns` calls from the original chat
 * are NOT planned here. They run naturally during the recipe's plan-
 * step execution (deterministic order preserves "create-before-use"),
 * which is simpler and avoids forking the existing tool plumbing.
 */

import type { Automation, DataSummary } from "../../shared/schema.js";

export type SessionTransformationStep =
  | { kind: "wide_format_remelt"; reason: string }
  | { kind: "copy_permanent_context"; charCount: number }
  | { kind: "seed_session_analysis_context" };

export interface SessionTransformationPlan {
  steps: SessionTransformationStep[];
  /** True when the saved automation has nothing to add upfront. */
  noOp: boolean;
}

/** True when the new dataset already has the long-form columns the
 *  saved transform expects. */
const newDatasetIsAlreadyLong = (
  newSummary: DataSummary | undefined,
  saved: Automation["sessionTransformations"]["wideFormatTransform"]
): boolean => {
  if (!saved || !newSummary) return false;
  const colNames = new Set(newSummary.columns.map((c) => c.name));
  return (
    colNames.has(saved.periodColumn) &&
    colNames.has(saved.valueColumn) &&
    colNames.has(saved.periodIsoColumn)
  );
};

export const planSessionTransformations = (
  newSummary: DataSummary | undefined,
  automation: Automation
): SessionTransformationPlan => {
  const steps: SessionTransformationStep[] = [];
  const transforms = automation.sessionTransformations;

  // Step 1: wide-format remelt
  if (transforms.wideFormatTransform?.detected) {
    const newDetected = newSummary?.wideFormatTransform?.detected === true;
    const alreadyLong = newDatasetIsAlreadyLong(
      newSummary,
      transforms.wideFormatTransform
    );
    if (alreadyLong) {
      // No remelt needed; auto-detection on the new upload already produced
      // long form (or the dataset was already long).
    } else if (!newDetected) {
      steps.push({
        kind: "wide_format_remelt",
        reason:
          "Auto-detection on the new dataset did not classify it as wide-format, " +
          "but the saved automation expects long-form output. Forcing the saved transform.",
      });
    } else {
      // Auto-detection fired but produced long output that doesn't match
      // the saved expectations — take no action, let column-mapping handle.
    }
  }

  // Step 2: permanent context
  if (transforms.permanentContext && transforms.permanentContext.trim()) {
    steps.push({
      kind: "copy_permanent_context",
      charCount: transforms.permanentContext.length,
    });
  }

  // Step 3: session analysis context seed
  if (transforms.seedSessionAnalysisContext) {
    steps.push({ kind: "seed_session_analysis_context" });
  }

  return {
    steps,
    noOp: steps.length === 0,
  };
};
