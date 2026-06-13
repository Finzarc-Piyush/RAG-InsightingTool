import type { ChatDocument } from "../models/chat.model.js";
import type { Message } from "../shared/schema.js";
import {
  mergePivotSliceDefaults,
  pivotSliceDefaultsFromDimensionFilters,
  readDimensionFiltersFromParsed,
} from "./pivotSliceDefaultsFromDimensionFilters.js";
import { classifyAnalysisSpec } from "./analysisSpecRouter.js";
import {
  diagnosticPivotMergeMinConfidence,
  isDiagnosticPivotFilterMergeEnabled,
} from "./diagnosticPipelineConfig.js";

function readConfidence(parsedQuery: Record<string, unknown> | null | undefined): number {
  if (!parsedQuery) return 0;
  const c = parsedQuery.confidence;
  return typeof c === "number" && Number.isFinite(c) ? c : 0;
}

/**
 * Merge parser dimension slice into agent intermediate pivot hints when gates pass.
 * When gates fail, returns `segmentPivot` unchanged (backward compatible).
 */
export function mergeIntermediateSegmentPivotDefaults(params: {
  dataSummary: ChatDocument["dataSummary"];
  userMessage: string;
  parsedQuery: Record<string, unknown> | null;
  segmentPivot?: Message["pivotDefaults"];
}): Message["pivotDefaults"] | undefined {
  const { dataSummary, userMessage, parsedQuery, segmentPivot } = params;
  if (!segmentPivot?.rows?.length || !segmentPivot?.values?.length) {
    return segmentPivot;
  }

  if (!isDiagnosticPivotFilterMergeEnabled()) {
    return segmentPivot;
  }

  const spec = classifyAnalysisSpec(userMessage, dataSummary);
  if (spec.mode !== "diagnostic") {
    return segmentPivot;
  }

  const dimensionFilters = readDimensionFiltersFromParsed(parsedQuery);
  if (!dimensionFilters?.length) {
    return segmentPivot;
  }

  const confidence = readConfidence(parsedQuery);
  if (confidence < diagnosticPivotMergeMinConfidence()) {
    return segmentPivot;
  }

  const parserSlice = pivotSliceDefaultsFromDimensionFilters(
    dataSummary,
    dimensionFilters,
    segmentPivot.rows,
    segmentPivot.columns ?? []
  );
  const mergedSlice = mergePivotSliceDefaults(parserSlice, {
    filterFields: segmentPivot.filterFields ?? [],
    filterSelections: segmentPivot.filterSelections ?? {},
  });

  const out: Message["pivotDefaults"] = {
    rows: [...segmentPivot.rows],
    values: [...segmentPivot.values],
  };
  if (segmentPivot.columns?.length) {
    out.columns = [...segmentPivot.columns];
  }
  if (mergedSlice.filterFields.length) {
    out.filterFields = mergedSlice.filterFields;
  }
  if (Object.keys(mergedSlice.filterSelections).length) {
    out.filterSelections = mergedSlice.filterSelections;
  }
  // Wave PAG1 · preserve agent-supplied aggregator hints across the
  // diagnostic-pivot filter merge — the merge enriches `filterFields` /
  // `filterSelections` but must not drop the per-value aggregator the
  // segment carried in.
  if (
    segmentPivot.valueAggregators &&
    Object.keys(segmentPivot.valueAggregators).length > 0
  ) {
    out.valueAggregators = { ...segmentPivot.valueAggregators };
  }
  return out;
}
