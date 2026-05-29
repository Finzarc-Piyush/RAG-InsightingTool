/**
 * Wave W-GMK1 · resolvePeriodAxis
 *
 * Pure helper that picks ONE coherent time-axis column when an analytical
 * result carries multiple period-related columns at different grains
 * (e.g. the Marico FMCG wide-format shape: `Day · Period`, `Week · Period`,
 * `Month · Period`, ..., `Year · Period`, `Period`, `PeriodIso`, `PeriodKind`).
 *
 * Why this exists: `chartFromTable.ts` picks the first non-numeric column as
 * x-axis, which on a Marico result-table happily plots `Period` (containing
 * mixed-kind labels like `Q1_25`, `Latest_12_Mths`, `YTD_TY`, `2024` in one
 * column) and produces a nonsense chart where rolling windows, quarters and
 * YTD overlap on one axis with no chronological ordering. This resolver
 * returns a single coherent decision the caller injects upstream of the
 * chart spec compile.
 *
 * Pure: no IO, no LLM, no side effects. Drives the chart-build path and
 * `visualPlanner.ts` deterministic fallback (W-GMK2 + W-GMK3 integrate).
 */
import {
  matchPeriod,
  type PeriodKind,
} from "./wideFormat/periodVocabulary.js";
import {
  isTemporalFacetColumnKey,
  parseTemporalFacetDisplayKey,
  detectCoarseTimeIntentFromMessage,
  type TemporalFacetGrain,
  type CoarseTimeIntent,
} from "./temporalFacetColumns.js";
import type { DataSummary } from "../shared/schema.js";

/** W-GMK5 · the classifications a column can receive during period detection. */
export type PeriodColumnRole =
  | "temporal-facet"
  | "raw-period"
  | "period-kind-discriminator"
  | "date"
  | "period-like-content";

export interface DetectedPeriodColumn {
  column: string;
  role: PeriodColumnRole;
  /** Pre-faceted columns encode the grain in the name; raw periods don't. */
  facetGrain?: TemporalFacetGrain;
  /** For raw-period and content columns: kinds detected in the sample. */
  detectedKinds?: PeriodKind[];
  uniqueValueCount: number;
}

export interface PeriodAxisDecision {
  /** Single column to use as time x-axis; null when no coherent pick. */
  pickedColumn: string | null;
  /** All columns identified as period-related (for caller dedupe / context). */
  periodColumns: string[];
  /** When pickedColumn is multi-kind, the canonical kind we filter to. */
  pinnedKind?: PeriodKind;
  /** Filter the caller injects downstream so only one kind's rows are kept. */
  injectedFilter?: { column: string; op: "eq"; value: string };
  /** Human-readable explanation (rendered as chart subtitle). */
  reason: string;
}

const RAW_PERIOD_NAME_RE = /^(period|periodiso)$/i;
const PERIOD_KIND_NAME_RE = /^periodkind$/i;

/** Default grain preference when no question intent matches. Most useful first. */
const DEFAULT_FACET_PREFERENCE: TemporalFacetGrain[] = [
  "month",
  "quarter",
  "week",
  "year",
  "half_year",
  "date",
];

const INTENT_TO_FACET_GRAIN: Record<CoarseTimeIntent, TemporalFacetGrain> = {
  day: "date",
  week: "week",
  month: "month",
  quarter: "quarter",
  half_year: "half_year",
  year: "year",
};

const INTENT_TO_PERIOD_KIND: Record<CoarseTimeIntent, PeriodKind> = {
  day: "week",
  week: "week",
  month: "month",
  quarter: "quarter",
  half_year: "quarter",
  year: "year",
};

const KIND_LITERAL_SYNONYMS: Record<PeriodKind, string[]> = {
  month: ["month", "monthly", "mth"],
  quarter: ["quarter", "quarterly", "qtr"],
  year: ["year", "annual", "yearly", "yr"],
  week: ["week", "weekly", "wk"],
  mat: ["mat", "moving annual"],
  ytd: ["ytd", "year to date"],
  rolling: ["rolling", "p4w", "p13w", "p52w", "l4w", "l12w", "l52w"],
  latest_n: ["latest", "trailing", "l12m"],
};

interface ColumnClassification {
  column: string;
  type:
    | "temporal-facet"
    | "raw-period"
    | "period-kind-discriminator"
    | "date"
    | "period-like-content";
  facetGrain?: TemporalFacetGrain;
  detectedKinds?: PeriodKind[];
  dominantKind?: PeriodKind;
  uniqueValueCount: number;
}

function scanRawPeriodColumn(
  col: string,
  sample: Record<string, unknown>[]
): {
  kinds: PeriodKind[];
  dominant?: PeriodKind;
  confidence: number;
  uniqueValueCount: number;
} {
  const counts = new Map<PeriodKind, number>();
  const distinct = new Set<string>();
  let scanned = 0;
  let matched = 0;
  let confSum = 0;
  for (const row of sample) {
    const v = row?.[col];
    if (v == null || v === "") continue;
    const s = String(v);
    distinct.add(s);
    scanned++;
    const m = matchPeriod(s);
    if (m && m.confidence >= 0.4) {
      matched++;
      confSum += m.confidence;
      counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
    }
  }
  if (scanned === 0)
    return { kinds: [], confidence: 0, uniqueValueCount: 0 };
  const ratio = matched / scanned;
  const meanConf = matched > 0 ? confSum / matched : 0;
  const kinds = [...counts.keys()];
  const dominant = kinds.length
    ? kinds.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0]
    : undefined;
  return {
    kinds,
    dominant,
    confidence: ratio * meanConf,
    uniqueValueCount: distinct.size,
  };
}

function countUnique(col: string, sample: Record<string, unknown>[]): number {
  const s = new Set<string>();
  for (const row of sample) {
    const v = row?.[col];
    if (v == null || v === "") continue;
    s.add(String(v));
  }
  return s.size;
}

function classifyColumns(
  columns: string[],
  sample: Record<string, unknown>[],
  summary: DataSummary
): ColumnClassification[] {
  const out: ColumnClassification[] = [];
  for (const col of columns) {
    if (PERIOD_KIND_NAME_RE.test(col)) {
      out.push({
        column: col,
        type: "period-kind-discriminator",
        uniqueValueCount: countUnique(col, sample),
      });
      continue;
    }
    if (isTemporalFacetColumnKey(col)) {
      const parsed = parseTemporalFacetDisplayKey(col);
      if (parsed) {
        out.push({
          column: col,
          type: "temporal-facet",
          facetGrain: parsed.grain,
          uniqueValueCount: countUnique(col, sample),
        });
        continue;
      }
    }
    if (RAW_PERIOD_NAME_RE.test(col)) {
      // Name match alone is sufficient — a column literally called `Period`
      // or `PeriodIso` is a period column even when its values use a shape
      // (e.g. "2024-Q1" ISO quarters) that the vocab matcher doesn't yet
      // recognise. Kind detection is best-effort downstream.
      const scan = scanRawPeriodColumn(col, sample);
      out.push({
        column: col,
        type: "raw-period",
        detectedKinds: scan.kinds,
        dominantKind: scan.dominant,
        uniqueValueCount:
          scan.uniqueValueCount > 0 ? scan.uniqueValueCount : countUnique(col, sample),
      });
      continue;
    }
    if (summary.dateColumns.includes(col)) {
      out.push({
        column: col,
        type: "date",
        uniqueValueCount: countUnique(col, sample),
      });
      continue;
    }
    const scan = scanRawPeriodColumn(col, sample);
    if (scan.confidence >= 0.6 && scan.kinds.length > 0) {
      out.push({
        column: col,
        type: "period-like-content",
        detectedKinds: scan.kinds,
        dominantKind: scan.dominant,
        uniqueValueCount: scan.uniqueValueCount,
      });
    }
  }
  return out;
}

function pickByIntent(
  classifications: ColumnClassification[],
  intent: CoarseTimeIntent
): { picked: ColumnClassification; pinKind?: PeriodKind } | null {
  const desiredGrain = INTENT_TO_FACET_GRAIN[intent];
  const desiredKind = INTENT_TO_PERIOD_KIND[intent];

  const facet = classifications.find(
    (c) =>
      c.type === "temporal-facet" &&
      c.facetGrain === desiredGrain &&
      c.uniqueValueCount >= 2
  );
  if (facet) return { picked: facet };

  const rawWithKind = classifications.find(
    (c) =>
      (c.type === "raw-period" || c.type === "period-like-content") &&
      c.detectedKinds?.includes(desiredKind) &&
      c.uniqueValueCount >= 2
  );
  if (rawWithKind) return { picked: rawWithKind, pinKind: desiredKind };

  return null;
}

function pickByDefault(
  classifications: ColumnClassification[]
): { picked: ColumnClassification; pinKind?: PeriodKind } | null {
  for (const grain of DEFAULT_FACET_PREFERENCE) {
    const facet = classifications.find(
      (c) =>
        c.type === "temporal-facet" &&
        c.facetGrain === grain &&
        c.uniqueValueCount >= 2
    );
    if (facet) return { picked: facet };
  }

  const period = classifications.find(
    (c) =>
      c.type === "raw-period" &&
      c.column.toLowerCase() === "period" &&
      c.uniqueValueCount >= 2
  );
  const periodIso = classifications.find(
    (c) =>
      c.type === "raw-period" &&
      c.column.toLowerCase() === "periodiso" &&
      c.uniqueValueCount >= 2
  );
  const rawPick = period ?? periodIso;
  if (rawPick) {
    const pinKind =
      rawPick.detectedKinds && rawPick.detectedKinds.length > 1
        ? rawPick.dominantKind
        : undefined;
    return { picked: rawPick, pinKind };
  }

  const dateCol = classifications.find(
    (c) => c.type === "date" && c.uniqueValueCount >= 2
  );
  if (dateCol) return { picked: dateCol };

  const content = classifications.find(
    (c) => c.type === "period-like-content" && c.uniqueValueCount >= 2
  );
  if (content) {
    const pinKind =
      content.detectedKinds && content.detectedKinds.length > 1
        ? content.dominantKind
        : undefined;
    return { picked: content, pinKind };
  }
  return null;
}

function findKindLiteralInSample(
  kindCol: string,
  desired: PeriodKind,
  sample: Record<string, unknown>[]
): string | null {
  const counts = new Map<string, number>();
  for (const row of sample) {
    const v = row?.[kindCol];
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const [literal] of counts) {
    if (literal.toLowerCase() === desired.toLowerCase()) return literal;
  }
  const syns = KIND_LITERAL_SYNONYMS[desired];
  for (const [literal] of counts) {
    const lower = literal.toLowerCase();
    if (syns.some((syn) => lower.includes(syn))) return literal;
  }
  return null;
}

function buildReason(
  picked: ColumnClassification,
  pinnedKind: PeriodKind | undefined,
  filter: PeriodAxisDecision["injectedFilter"] | undefined,
  multiKindUnpinnedWarning: boolean
): string {
  const col = picked.column;
  if (pinnedKind && filter) {
    return `Showing ${col} (filtered to ${filter.column} = ${filter.value}, sorted chronologically)`;
  }
  // When we wanted to pin but couldn't (no discriminator column), surface the
  // warning before falling through to the bare "pinned" wording so the caller
  // can show the user that the chart may mix grains.
  if (multiKindUnpinnedWarning) {
    return `Showing ${col} (multiple period kinds present; chronological ordering may be unstable)`;
  }
  if (pinnedKind) {
    return `Showing ${col} (pinned to ${pinnedKind}-kind values, sorted chronologically)`;
  }
  return `Showing ${col} (sorted chronologically)`;
}

/**
 * Resolve a single coherent time-axis column from the result table's columns.
 *
 * Algorithm:
 * 1. Classify each column: temporal-facet (e.g. `Month · Date`), raw-period
 *    (`Period` / `PeriodIso`), period-kind discriminator (`PeriodKind`),
 *    native date, or content-detected (values look like periods).
 * 2. If question intent matches a coarse grain (e.g. "quarterly"), prefer the
 *    matching temporal facet; else prefer a raw period whose detected kinds
 *    include the desired kind and pin to it.
 * 3. Otherwise pick by default: Month > Quarter > Week > Year > Half-year >
 *    Day temporal facet; else raw `Period` (then `PeriodIso`); else any date
 *    column; else content-detected.
 * 4. When the pick is multi-kind, attempt to inject a `PeriodKind = <literal>`
 *    filter using fuzzy synonym match against the discriminator's actual
 *    values in the sample. If the discriminator is absent, surface a warning
 *    via `reason` instead.
 * 5. Single-cardinality columns are excluded from selection at every stage
 *    (no point plotting a one-value x-axis).
 */
/**
 * W-GMK5 · public detector — returns every column the resolver would
 * consider as period-related, with its classification metadata. Useful
 * for prompt builders (datasetProfile, planner system prompt) and any
 * downstream consumer that needs the period-facet grouping without
 * picking a specific axis. Pure; no IO, no LLM.
 */
export function detectPeriodColumns(
  columns: string[],
  sample: Record<string, unknown>[],
  summary: DataSummary
): DetectedPeriodColumn[] {
  if (columns.length === 0 || sample.length === 0) return [];
  return classifyColumns(columns, sample, summary).map((c) => ({
    column: c.column,
    role: c.type,
    ...(c.facetGrain ? { facetGrain: c.facetGrain } : {}),
    ...(c.detectedKinds && c.detectedKinds.length > 0
      ? { detectedKinds: c.detectedKinds }
      : {}),
    uniqueValueCount: c.uniqueValueCount,
  }));
}

export function resolvePeriodAxis(
  columns: string[],
  sample: Record<string, unknown>[],
  summary: DataSummary,
  question?: string
): PeriodAxisDecision {
  if (columns.length === 0 || sample.length === 0) {
    return {
      pickedColumn: null,
      periodColumns: [],
      reason: "No columns or sample to analyse",
    };
  }

  const classifications = classifyColumns(columns, sample, summary);

  const periodColumns = classifications
    .filter(
      (c) =>
        c.type === "temporal-facet" ||
        c.type === "raw-period" ||
        c.type === "date" ||
        c.type === "period-like-content"
    )
    .map((c) => c.column);

  if (periodColumns.length === 0) {
    return {
      pickedColumn: null,
      periodColumns: [],
      reason: "No period columns detected",
    };
  }

  const intent = question
    ? detectCoarseTimeIntentFromMessage(question)
    : null;

  const picked =
    (intent ? pickByIntent(classifications, intent) : null) ??
    pickByDefault(classifications);

  if (!picked) {
    return {
      pickedColumn: null,
      periodColumns,
      reason: "Period columns detected but none usable (cardinality < 2)",
    };
  }

  const kindCol = classifications.find(
    (c) => c.type === "period-kind-discriminator"
  );

  let injectedFilter: PeriodAxisDecision["injectedFilter"];
  const pinnedKind: PeriodKind | undefined = picked.pinKind;
  let multiKindUnpinnedWarning = false;

  if (pinnedKind && kindCol) {
    const literalValue = findKindLiteralInSample(
      kindCol.column,
      pinnedKind,
      sample
    );
    if (literalValue) {
      injectedFilter = { column: kindCol.column, op: "eq", value: literalValue };
    }
  }
  if (pinnedKind && !injectedFilter) {
    multiKindUnpinnedWarning = true;
  }

  const reason = buildReason(
    picked.picked,
    pinnedKind,
    injectedFilter,
    multiKindUnpinnedWarning
  );

  return {
    pickedColumn: picked.picked.column,
    periodColumns,
    ...(pinnedKind ? { pinnedKind } : {}),
    ...(injectedFilter ? { injectedFilter } : {}),
    reason,
  };
}
