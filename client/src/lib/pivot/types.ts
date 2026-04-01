export type PivotAgg = 'sum' | 'mean' | 'count' | 'min' | 'max';

export type PivotValueSpec = {
  id: string;
  field: string;
  agg: PivotAgg;
};

export type PivotUiConfig = {
  filters: string[];
  columns: string[];
  rows: string[];
  values: PivotValueSpec[];
  unused: string[];
  /**
   * How pivot row groups should be ordered.
   * If unset, the UI falls back to key-based ordering (chronological when labels are temporal).
   */
  rowSort?: {
    /** Required when primary is measure (or omitted). */
    byValueSpecId?: string;
    direction: "asc" | "desc";
    /** Sort by row dimension labels (time-aware) instead of by a measure. */
    primary?: "measure" | "rowLabel";
  };
};

/** Per filter field: which raw values to include (empty = all). */
export type FilterSelections = Record<string, Set<string>>;

export type PivotAggRow = {
  flatValues: Record<string, number> | null;
  matrixValues: Record<string, Record<string, number>> | null;
};

export type PivotLeafNode = {
  type: 'leaf';
  depth: number;
  label: string;
  pathKey: string;
  values: PivotAggRow;
};

export type PivotGroupNode = {
  type: 'group';
  depth: number;
  label: string;
  pathKey: string;
  children: (PivotGroupNode | PivotLeafNode)[];
  subtotal: PivotAggRow;
};

export type PivotTree = {
  nodes: (PivotGroupNode | PivotLeafNode)[];
  grandTotal: PivotAggRow;
};

/** Flattened row for rendering (from tree + collapsed set). */
export type PivotFlatRow =
  | {
      kind: 'header';
      depth: number;
      label: string;
      pathKey: string;
      values: null;
    }
  | {
      kind: 'collapsed';
      depth: number;
      label: string;
      pathKey: string;
      values: PivotAggRow;
    }
  | {
      kind: 'data';
      depth: number;
      label: string;
      pathKey: string;
      values: PivotAggRow;
    }
  | {
      kind: 'subtotal';
      depth: number;
      label: string;
      pathKey: string;
      values: PivotAggRow;
    }
  | {
      kind: 'grand';
      depth: number;
      label: string;
      pathKey: string;
      values: PivotAggRow;
    };

export type PivotModel = {
  rowFields: string[];
  colField: string | null;
  /** Column area field ids (only first used for matrix when non-empty). */
  columnFields: string[];
  colKeys: string[];
  valueSpecs: PivotValueSpec[];
  tree: PivotTree;
  /** True when columns.length > 1 and only first is used */
  columnFieldTruncated: boolean;
};
