/**
 * Wave C3 · SchemaIndex — pre-computed dataset metadata TYPES.
 *
 * NOTE: the runtime cache + builders (sessionIndexCache / ensureSchemaIndex /
 * buildSchemaIndex / updateSchemaIndexColumn + the stats compute helpers) were
 * removed — they had zero callers anywhere in the codebase (the index was never
 * wired into the agent turn). Only the type definitions remain, which are still
 * imported (type-only) by dataProvenance.ts (NumericStats) and
 * stratifiedSample.ts (SchemaIndex, AssociationEntry).
 *
 * If a typed schema index is wired up later, key any cache on `dataVersion`
 * (as the live caches in pivotQueryService.ts / questionCacheLookup.ts do) and
 * invalidate it on the data-ops mutation path.
 */

export type ColumnKind = "numeric" | "categorical" | "date" | "id" | "unknown";

export interface NumericStats {
  column: string;
  count: number;
  nullCount: number;
  mean: number;
  std: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  max: number;
  /** IQR-based outlier bounds: rows outside [low, high] are flagged. */
  outlierLow: number;
  outlierHigh: number;
}

export interface CategoricalStats {
  column: string;
  cardinality: number;
  nullCount: number;
  /** Full top-values list, frequency-sorted; not capped at 8. */
  topValues: Array<{ value: string; count: number }>;
  entropyBits: number;
}

export interface DateRange {
  column: string;
  min: string | null;
  max: string | null;
  rangeDays: number | null;
  hasGaps: boolean;
}

export interface CorrelationEntry {
  a: string;
  b: string;
  /** Pearson r (numeric × numeric). */
  pearson: number;
  /** Number of (a, b) pairs that contributed. */
  n: number;
}

export interface AssociationEntry {
  a: string;
  b: string;
  /** Cramér's V (categorical × categorical). 0 = independent, 1 = full assoc. */
  cramersV: number;
  n: number;
}

export interface AnomalyRecord {
  rowIndex: number;
  outlierColumns: string[];
}

export interface SchemaIndex {
  builtAt: number;
  dataVersion: number | null;
  rowCount: number;
  columnKinds: Record<string, ColumnKind>;
  numericStats: Record<string, NumericStats>;
  categoricalStats: Record<string, CategoricalStats>;
  dateRanges: Record<string, DateRange>;
  correlations: CorrelationEntry[];
  associations: AssociationEntry[];
  anomalies: { count: number; sample: AnomalyRecord[] };
}
