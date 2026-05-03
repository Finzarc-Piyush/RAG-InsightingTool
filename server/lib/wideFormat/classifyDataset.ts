// Wide-format classifier — given a list of column headers, decide
// whether the dataset is wide (period-as-columns) and what melt
// shape is appropriate.
//
// Three shapes:
//   - pure_period:       id columns + ≥3 period columns, no metric in
//                        header (metric is implicit or carried in a
//                        row column like Nielsen "Facts").
//   - compound:          id columns + columns whose header encodes
//                        BOTH a period and a metric (e.g.
//                        "Q1 23 Value Sales", "Q1 23 Volume").
//   - pivot_metric_row:  same as pure_period but explicitly noted
//                        when one of the id-tagged columns has
//                        metric-like values (caller decides).
//
// Detection thresholds:
//   - period+compound count ≥ max(3, 30% of total columns)
//   - ≥2 distinct period ISO values (a single "Q1 23" column is
//     just a label, not an axis)
//   - ≥1 id-tagged column to anchor each row

import { tagColumn, type ColumnTagResult } from "./tagColumn.js";

export type WideShape = "pure_period" | "compound" | "pivot_metric_row";

export interface DatasetClassification {
  isWide: boolean;
  shape: WideShape | null;
  idColumns: string[];
  periodColumns: string[];
  metricColumns: string[];
  compoundColumns: string[];
  ambiguousColumns: string[];
  /** ISO labels for distinct periods detected. */
  distinctPeriodIsos: string[];
  /** Human-readable rationale (workbench / debugging). */
  reason: string;
  /** Per-header tag results, in original order. */
  tags: ColumnTagResult[];
}

const MIN_PERIOD_COLS = 3;
const PERIOD_FRACTION = 0.3;

export function classifyDataset(headers: string[]): DatasetClassification {
  const tags = headers.map((h) => tagColumn(h));
  const idColumns: string[] = [];
  const periodColumns: string[] = [];
  const metricColumns: string[] = [];
  const compoundColumns: string[] = [];
  const ambiguousColumns: string[] = [];
  const periodIsos = new Set<string>();

  for (const t of tags) {
    switch (t.tag) {
      case "id":
        idColumns.push(t.header);
        break;
      case "period":
        periodColumns.push(t.header);
        if (t.period) periodIsos.add(t.period.iso);
        break;
      case "metric":
        metricColumns.push(t.header);
        break;
      case "compound":
        compoundColumns.push(t.header);
        if (t.period) periodIsos.add(t.period.iso);
        break;
      default:
        ambiguousColumns.push(t.header);
    }
  }

  const total = headers.length;
  const periodLikeCount = periodColumns.length + compoundColumns.length;
  const threshold = Math.max(MIN_PERIOD_COLS, Math.ceil(total * PERIOD_FRACTION));
  const distinctPeriodIsos = Array.from(periodIsos);

  // Negative-result reasons, evaluated in order.
  if (total === 0) {
    return notWide(tags, idColumns, periodColumns, metricColumns, compoundColumns, ambiguousColumns, distinctPeriodIsos, "no headers");
  }
  if (periodLikeCount < threshold) {
    return notWide(
      tags,
      idColumns,
      periodColumns,
      metricColumns,
      compoundColumns,
      ambiguousColumns,
      distinctPeriodIsos,
      `only ${periodLikeCount} period-like column(s); need ≥${threshold}`
    );
  }
  if (distinctPeriodIsos.length < 2) {
    return notWide(
      tags,
      idColumns,
      periodColumns,
      metricColumns,
      compoundColumns,
      ambiguousColumns,
      distinctPeriodIsos,
      `only ${distinctPeriodIsos.length} distinct period iso(s); need ≥2`
    );
  }
  if (idColumns.length < 1) {
    return notWide(
      tags,
      idColumns,
      periodColumns,
      metricColumns,
      compoundColumns,
      ambiguousColumns,
      distinctPeriodIsos,
      "no id-tagged column to anchor melted rows"
    );
  }

  // Decide shape. Compound dominates if any compound column exists.
  const shape: WideShape =
    compoundColumns.length > 0 ? "compound" : "pure_period";
  return {
    isWide: true,
    shape,
    idColumns,
    periodColumns,
    metricColumns,
    compoundColumns,
    ambiguousColumns,
    distinctPeriodIsos,
    reason: `wide-${shape}: ${periodLikeCount}/${total} period-like cols, ${distinctPeriodIsos.length} distinct periods, ${idColumns.length} id col(s)`,
    tags,
  };
}

function notWide(
  tags: ColumnTagResult[],
  idColumns: string[],
  periodColumns: string[],
  metricColumns: string[],
  compoundColumns: string[],
  ambiguousColumns: string[],
  distinctPeriodIsos: string[],
  reason: string
): DatasetClassification {
  return {
    isWide: false,
    shape: null,
    idColumns,
    periodColumns,
    metricColumns,
    compoundColumns,
    ambiguousColumns,
    distinctPeriodIsos,
    reason,
    tags,
  };
}
