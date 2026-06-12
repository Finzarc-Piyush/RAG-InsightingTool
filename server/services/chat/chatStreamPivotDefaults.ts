/**
 * Chat Stream · pivot-defaults derivation helpers
 *
 * Extracted from `chatStream.service.ts` (Wave R-decompose). This is a
 * cohesive, low-coupling cluster: it derives the `pivotDefaults` hint shape
 * shipped on assistant responses from (a) the NL parser output, (b) the
 * agent's execution trace, and merges the two. Every dependency is an
 * EXTERNAL module — there is no runtime import back into the god-file, so no
 * cycle. The god-file re-exports `mergePivotDefaultsForResponse` from here so
 * existing importers (e.g. `tests/chatStreamScalarPivot.test.ts`) keep
 * resolving against `chatStream.service.js` unchanged.
 */
import type { Message } from "../../shared/schema.js";
import type { ChatDocument } from "../../models/chat.model.js";
import { allowedColumnNamesForQueryPlan } from "../../lib/queryPlanExecutor.js";
import {
  derivePivotDefaultsFromExecutionMerged,
  type PivotDefaultsRowsValues,
} from "../../lib/pivotDefaultsFromExecution.js";
import { normalizePivotValueFieldForBaseTable } from "../../lib/pivotDefaultsFromPreview.js";
import type { DimensionFilter } from "../../shared/queryTypes.js";
import {
  mergePivotSliceDefaults,
  pivotSliceDefaultsFromDimensionFilters,
} from "../../lib/pivotSliceDefaultsFromDimensionFilters.js";
import {
  sanitisePivotColumnDimensionsInput,
  suggestPivotColumnsFromDimensions,
} from "../../lib/pivotLayoutFromDimensions.js";
import { logger } from "../../lib/logger.js";

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

export function mergePivotDefaultsForResponse(params: {
  dataSummary: ChatDocument["dataSummary"];
  parsedQuery: Record<string, unknown> | null;
  parserPivot: Message["pivotDefaults"] | undefined;
  executionPivot: PivotDefaultsRowsValues | undefined;
}): Message["pivotDefaults"] | undefined {
  const { dataSummary, parsedQuery, parserPivot, executionPivot } = params;
  // Scalar agent answers (single-row aggregate, no group-by) must not fabricate
  // row dimensions from the parser's schema heuristic — suppress the pivot.
  if (executionPivot?.scalar === true) {
    return undefined;
  }
  const finalRows = executionPivot?.rows?.length
    ? executionPivot.rows
    : parserPivot?.rows;
  const finalValues = executionPivot?.values?.length
    ? executionPivot.values
    : parserPivot?.values;
  const hasRows = finalRows && finalRows.length > 0;
  const hasValues = finalValues && finalValues.length > 0;
  if (!hasRows && !hasValues) return undefined;

  const finalColumns =
    executionPivot?.columns?.length
      ? executionPivot.columns
      : parserPivot?.columns;
  const colKeys = finalColumns?.length ? finalColumns : [];

  const parserSlice = pivotSliceDefaultsFromDimensionFilters(
    dataSummary,
    readDimensionFiltersFromParsed(parsedQuery),
    finalRows ?? [],
    colKeys
  );
  const mergedSlice = mergePivotSliceDefaults(parserSlice, {
    filterFields: executionPivot?.filterFields ?? [],
    filterSelections: executionPivot?.filterSelections ?? {},
  });

  const out: Message["pivotDefaults"] = {
    rows: finalRows ?? [],
    values: finalValues ?? [],
  };
  if (colKeys.length) {
    out.columns = colKeys;
  }
  if (mergedSlice.filterFields.length) {
    out.filterFields = mergedSlice.filterFields;
  }
  if (Object.keys(mergedSlice.filterSelections).length) {
    out.filterSelections = mergedSlice.filterSelections;
  }
  // Wave PAG1 · Forward the per-column aggregator hints derived in
  // `mergePivotDefaultRowsAndValues`. Parser-side never knew aggregators,
  // so it has nothing to merge — straight pass-through of the execution
  // side. Dropped entirely when the execution path didn't emit any.
  if (
    executionPivot?.valueAggregators &&
    Object.keys(executionPivot.valueAggregators).length > 0
  ) {
    out.valueAggregators = { ...executionPivot.valueAggregators };
  }
  return out;
}

export function derivePivotDefaultsHint(params: {
  parsedQuery: Record<string, unknown> | null;
  requiredColumns: string[];
  dataSummary: ChatDocument["dataSummary"];
}): Message["pivotDefaults"] | undefined {
  const { parsedQuery, requiredColumns, dataSummary } = params;
  const allowed = allowedColumnNamesForQueryPlan(dataSummary);
  const numeric = new Set(dataSummary.numericColumns || []);
  const dateColumns = new Set(dataSummary.dateColumns || []);

  const rows: string[] = [];
  const values: string[] = [];
  const seenRows = new Set<string>();
  const seenValues = new Set<string>();

  const addRow = (col: string) => {
    if (!allowed.has(col) || numeric.has(col) || seenRows.has(col)) return;
    seenRows.add(col);
    rows.push(col);
  };
  const addValue = (col: string) => {
    if (!allowed.has(col) || !numeric.has(col) || seenValues.has(col)) return;
    seenValues.add(col);
    values.push(col);
  };

  const groupBy = Array.isArray(parsedQuery?.groupBy)
    ? (parsedQuery!.groupBy as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  for (const col of groupBy) addRow(col);

  const aggregations = Array.isArray(parsedQuery?.aggregations)
    ? (parsedQuery!.aggregations as Array<{ column?: unknown }>)
    : [];
  for (const agg of aggregations) {
    if (typeof agg?.column === "string") addValue(agg.column);
  }

  const requiredDimensionColumns = requiredColumns.filter(
    (col) => allowed.has(col) && !numeric.has(col)
  );
  const requiredDateDims = requiredDimensionColumns.filter((col) => dateColumns.has(col));
  // Only backfill row dimensions from required columns when parsed groupBy didn't
  // provide valid row hints. This keeps intent-derived dimensions in the first slot.
  if (rows.length === 0) {
    for (const col of [...requiredDateDims, ...requiredDimensionColumns]) addRow(col);
  }
  for (const col of requiredColumns) addValue(col);

  if (rows.length === 0 && values.length === 0) return undefined;

  const pcd = sanitisePivotColumnDimensionsInput(
    parsedQuery?.pivotColumnDimensions,
    dataSummary
  );
  const laid = suggestPivotColumnsFromDimensions({
    rowCandidates: rows,
    dataSummary,
    pivotColumnDimensions: pcd.length ? pcd : undefined,
  });
  const rowFinal = laid.rows;
  const columnsFinal = laid.columns;

  const seenNorm = new Set<string>();
  const normalizedValues: string[] = [];
  for (const v of values) {
    const n = normalizePivotValueFieldForBaseTable(v, dataSummary);
    if (seenNorm.has(n)) continue;
    seenNorm.add(n);
    normalizedValues.push(n);
  }
  const slice = pivotSliceDefaultsFromDimensionFilters(
    dataSummary,
    readDimensionFiltersFromParsed(parsedQuery),
    rowFinal,
    columnsFinal
  );
  const hint: Message["pivotDefaults"] = {
    rows: rowFinal,
    values: normalizedValues,
  };
  if (columnsFinal.length) {
    hint.columns = columnsFinal;
  }
  if (slice.filterFields.length) {
    hint.filterFields = slice.filterFields;
  }
  if (Object.keys(slice.filterSelections).length) {
    hint.filterSelections = slice.filterSelections;
  }
  if (process.env.NODE_ENV !== "production") {
    logger.debug("[chatStream] pivotDefaults hint", {
      groupBy,
      requiredColumns: requiredColumns.slice(0, 8),
      rows: hint.rows,
      columns: hint.columns,
      values: hint.values,
      filterFields: hint.filterFields,
      filterSelections: hint.filterSelections,
    });
  }
  return hint;
}

export function derivePivotDefaultsFromExecution(params: {
  agentTrace?: Record<string, unknown>;
  table?: unknown;
  dataSummary: ChatDocument["dataSummary"];
}): PivotDefaultsRowsValues | undefined {
  return derivePivotDefaultsFromExecutionMerged(
    params.dataSummary,
    params.agentTrace,
    params.table
  );
}
