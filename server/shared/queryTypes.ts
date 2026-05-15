export type LogicalOperator = 'AND' | 'OR';

export interface TimeFilter {
  type: 'year' | 'month' | 'quarter' | 'dateRange' | 'relative';
  column?: string;
  years?: number[];
  months?: string[]; // Full or short month names
  quarters?: Array<1 | 2 | 3 | 4>;
  startDate?: string; // ISO string
  endDate?: string;   // ISO string
  relative?: {
    unit: 'month' | 'quarter' | 'year' | 'week';
    direction: 'past' | 'future';
    amount: number;
  };
}

export type ComparisonOperator = '>' | '>=' | '<' | '<=' | '=' | 'between' | '!=';

export interface ValueFilter {
  column: string;
  operator: ComparisonOperator;
  value?: number;
  value2?: number; // used for between
  reference?: 'mean' | 'avg' | 'median' | 'p75' | 'p25' | 'max' | 'min';
}

export interface ExclusionFilter {
  column: string;
  values: Array<string | number>;
}

/** Categorical / string dimension filters (use instead of valueFilters for non-numeric columns). */
export type DimensionMatchMode = 'exact' | 'case_insensitive' | 'contains';

/**
 * CMP1 · DimensionFilter operator set.
 * - Categorical: `in` / `not_in` (multi-value, list semantics).
 * - Scalar comparison: `eq` / `neq` / `lt` / `lte` / `gt` / `gte` use `values[0]`.
 * - Range: `between` uses `values[0]` (low) and `values[1]` (high), inclusive.
 *
 * Comparison ops compare lexicographically on string-typed columns (correct for
 * HH:MM:SS time-of-day, ISO dates) and as casted DOUBLE on numeric columns —
 * the SQL builder picks the right path automatically.
 */
export type DimensionFilterOp =
  | 'in'
  | 'not_in'
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'between';

export interface DimensionFilter {
  column: string;
  op: DimensionFilterOp;
  values: string[];
  match?: DimensionMatchMode;
}

export interface TopBottomRequest {
  type: 'top' | 'bottom';
  column: string;
  count: number;
}

export type AggregationOperation =
  | 'sum'
  | 'mean'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'median'
  | 'percent_change'
  // PCT1 · conditional aggregations for "what % / share / proportion of X" questions.
  // Predicate is a DimensionFilter[] (ANDed). `countIf` ignores `column`; `sumIf` requires it.
  | 'countIf'
  | 'sumIf'
  // Wave QL7 · COUNT(DISTINCT col). First-class denominator for "average per X"
  // rate questions when paired with a SUM aggregation + a computed ratio
  // column (`computedAggregations`). Simpler than the nested perDimension
  // shape; emitted directly by the planner and the QL2 aggregation-intent
  // floor as the default shape for rate questions.
  | 'count_distinct';

export interface AggregationRequest {
  column: string;
  operation: AggregationOperation;
  alias?: string;
  /** PCT1 · required for countIf/sumIf; otherwise ignored. ANDed across entries. */
  predicate?: DimensionFilter[];
}

export interface SortRequest {
  column: string;
  direction: 'asc' | 'desc';
}

export interface ParsedQuery {
  rawQuestion: string;
  /** Parser self-reported confidence 0–1 (when produced by parseUserQuery). */
  confidence?: number;
  chartTypeHint?: 'line' | 'bar' | 'scatter' | 'pie' | 'area';
  variables?: string[];
  secondaryVariables?: string[];
  groupBy?: string[];
  /**
   * Non-numeric dimensions to place on the pivot Columns axis (matrix breakdown).
   * Omit when a single row breakdown or unclear; max one column is honored by the pivot engine.
   */
  pivotColumnDimensions?: string[];
  dateAggregationPeriod?:
    | 'day'
    | 'week'
    | 'half_year'
    | 'month'
    | 'monthOnly'
    | 'quarter'
    | 'year'
    | null;
  timeFilters?: TimeFilter[];
  valueFilters?: ValueFilter[];
  /** Filter string dimensions (e.g. Category in ["Technology"]). Do not use valueFilters for that. */
  dimensionFilters?: DimensionFilter[];
  exclusionFilters?: ExclusionFilter[];
  logicalOperator?: LogicalOperator;
  topBottom?: TopBottomRequest;
  aggregations?: AggregationRequest[];
  sort?: SortRequest[];
  limit?: number;
  notes?: string[];
}

