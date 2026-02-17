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

export interface TopBottomRequest {
  type: 'top' | 'bottom';
  column: string;
  count: number;
}

export type AggregationOperation = 'sum' | 'mean' | 'avg' | 'count' | 'min' | 'max' | 'median' | 'percent_change';

export interface AggregationRequest {
  column: string;
  operation: AggregationOperation;
  alias?: string;
}

export interface SortRequest {
  column: string;
  direction: 'asc' | 'desc';
}

export interface ParsedQuery {
  rawQuestion: string;
  chartTypeHint?: 'line' | 'bar' | 'scatter' | 'pie' | 'area';
  variables?: string[];
  secondaryVariables?: string[];
  groupBy?: string[];
  dateAggregationPeriod?: 'day' | 'month' | 'monthOnly' | 'quarter' | 'year' | null;
  timeFilters?: TimeFilter[];
  valueFilters?: ValueFilter[];
  exclusionFilters?: ExclusionFilter[];
  logicalOperator?: LogicalOperator;
  topBottom?: TopBottomRequest;
  aggregations?: AggregationRequest[];
  sort?: SortRequest[];
  limit?: number;
  notes?: string[];
}

/**
 * Query planning & execution types
 * Used by the two-stage planner → executor → explainer pipeline.
 */

export type QueryAction =
  | 'aggregate'
  | 'filter'
  | 'groupby'
  | 'topk'
  | 'row_lookup';

export type QueryFilterOperator =
  | '='
  | '>'
  | '<'
  | '>='
  | '<='
  | '!='
  | 'contains';

export interface QueryFilter {
  column: string;
  operator: QueryFilterOperator;
  value: string | number | boolean | null;
}

export type QueryAggregationType =
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max';

export interface QueryAggregation {
  column: string;
  type: QueryAggregationType;
}

export interface QuerySortBy {
  column: string;
  direction: 'asc' | 'desc';
}

export interface QueryPlan {
  action: QueryAction;
  filters: QueryFilter[];
  aggregations: QueryAggregation[];
  groupBy: string[];
  sortBy?: QuerySortBy;
  limit?: number;
  /**
   * Hint from planner about whether a full row-level scan
   * of the dataset is required. The executor may still
   * override this based on metadata capabilities.
   */
  requiresFullScan?: boolean;
}

export interface QueryResultMeta {
  rowCount: number;
  columns: string[];
  action: QueryAction;
  groupBy?: string[];
  sortBy?: QuerySortBy;
  limit?: number;
  diagnostics?: string[];
}

export interface QueryResult {
  rows: Array<Record<string, string | number | boolean | null>>;
  meta: QueryResultMeta;
}

