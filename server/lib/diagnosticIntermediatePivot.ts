import type { ChatDocument } from "../models/chat.model.js";
import type { Message } from "../shared/schema.js";
import type { DimensionFilter } from "../shared/queryTypes.js";
import {
  mergePivotSliceDefaults,
  pivotSliceDefaultsFromDimensionFilters,
} from "./pivotSliceDefaultsFromDimensionFilters.js";
import { classifyAnalysisSpec } from "./analysisSpecRouter.js";
import {
  diagnosticPivotMergeMinConfidence,
  isDiagnosticPivotFilterMergeEnabled,
} from "./diagnosticPipelineConfig.js";

function readDimensionFiltersFromParsed(
  parsedQuery: Record<string, unknown> | null | undefined
): DimensionFilter[] | undefined {
  if (!parsedQuery) return undefined;
  const raw = parsedQuery.dimensionFilters;
  if (!Array.isArray(raw)) return undefined;
  const out: DimensionFilter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.column !== "string") continue;
    if (o.op !== "in" && o.op !== "not_in") continue;
    if (!Array.isArray(o.values)) continue;
    out.push({
      column: o.column,
      op: o.op as "in" | "not_in",
      values: o.values.map((v) => String(v)),
      match:
        o.match === "exact" ||
        o.match === "case_insensitive" ||
        o.match === "contains"
          ? o.match
          : undefined,
    });
  }
  return out.length ? out : undefined;
}

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
  return out;
}
