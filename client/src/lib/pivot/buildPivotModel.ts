import { parseNumericCell } from '@/lib/formatAnalysisNumber';
import { compareTemporalOrLexicalLabels } from '@/lib/temporalAxisSort';
import type {
  FilterSelections,
  PivotAgg,
  PivotAggRow,
  PivotFlatRow,
  PivotGroupNode,
  PivotLeafNode,
  PivotModel,
  PivotTree,
  PivotUiConfig,
  PivotValueSpec,
} from './types';

function applyAgg(
  rows: Record<string, unknown>[],
  spec: PivotValueSpec
): number {
  const f = spec.field;
  if (spec.agg === 'count') {
    return rows.length;
  }
  const nums: number[] = [];
  for (const r of rows) {
    const n = parseNumericCell(r[f]);
    if (n !== null) nums.push(n);
  }
  if (nums.length === 0) {
    return spec.agg === 'sum' || spec.agg === 'mean' ? 0 : 0;
  }
  switch (spec.agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'mean':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    default:
      return 0;
  }
}

function aggregatePivot(
  rows: Record<string, unknown>[],
  valueSpecs: PivotValueSpec[],
  colField: string | null,
  colKeys: string[]
): PivotAggRow {
  if (!colField) {
    const flatValues: Record<string, number> = {};
    for (const spec of valueSpecs) {
      flatValues[spec.id] = applyAgg(rows, spec);
    }
    return { flatValues, matrixValues: null };
  }
  const matrixValues: Record<string, Record<string, number>> = {};
  for (const ck of colKeys) {
    matrixValues[ck] = {};
    const slice = rows.filter(
      (r) => pivotDimensionStringKey(r[colField]) === ck
    );
    for (const spec of valueSpecs) {
      matrixValues[ck][spec.id] = applyAgg(slice, spec);
    }
  }
  return { flatValues: null, matrixValues };
}

/** Stable key for grouping/filtering pivot dimensions (avoids `[object Object]`). */
function pivotDimensionStringKey(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number')
    return Number.isFinite(raw) ? String(raw) : '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw.toISOString();
  if (typeof raw === 'object') {
    try {
      const o = raw as Record<string, unknown>;
      return JSON.stringify(raw, Object.keys(o).sort());
    } catch {
      return '[unserializable]';
    }
  }
  return String(raw);
}

function groupByField(
  rows: Record<string, unknown>[],
  field: string
): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = pivotDimensionStringKey(r[field]);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

function sortedKeys(map: Map<string, Record<string, unknown>[]>): string[] {
  return [...map.keys()].sort(compareTemporalOrLexicalLabels);
}

function buildLevel(
  rows: Record<string, unknown>[],
  rowFields: string[],
  depth: number,
  pathPrefix: string[],
  colField: string | null,
  colKeys: string[],
  valueSpecs: PivotValueSpec[],
  rowSort?: PivotUiConfig["rowSort"]
): (PivotGroupNode | PivotLeafNode)[] {
  if (rowFields.length === 0) {
    return [];
  }
  const field = rowFields[depth];
  const isLast = depth === rowFields.length - 1;
  const groups = groupByField(rows, field);
  let keys = sortedKeys(groups);
  if (rowSort?.primary === 'rowLabel') {
    keys = [...groups.keys()].sort((a, b) => {
      const c = compareTemporalOrLexicalLabels(a, b);
      return rowSort.direction === 'desc' ? -c : c;
    });
  } else if (rowSort?.byValueSpecId) {
    const chosen = valueSpecs.find((v) => v.id === rowSort.byValueSpecId);
    if (chosen) {
      keys = [...groups.keys()].sort((a, b) => {
        const subA = groups.get(a)!;
        const subB = groups.get(b)!;
        const totalA = applyAgg(subA, chosen);
        const totalB = applyAgg(subB, chosen);

        if (totalA === totalB) {
          return compareTemporalOrLexicalLabels(a, b);
        }

        // desc => higher totals first
        const diff = totalA - totalB;
        return rowSort.direction === "desc" ? -diff : diff;
      });
    }
  }
  const out: (PivotGroupNode | PivotLeafNode)[] = [];

  for (const k of keys) {
    const sub = groups.get(k)!;
    const path = [...pathPrefix, k];
    const pathKey = path.join('\x1f');
    if (isLast) {
      out.push({
        type: 'leaf',
        depth,
        label: k,
        pathKey,
        values: aggregatePivot(sub, valueSpecs, colField, colKeys),
      });
    } else {
      const children = buildLevel(
        sub,
        rowFields,
        depth + 1,
        path,
        colField,
        colKeys,
        valueSpecs,
        rowSort
      );
      const subtotal = aggregatePivot(sub, valueSpecs, colField, colKeys);
      out.push({
        type: 'group',
        depth,
        label: k,
        pathKey,
        children,
        subtotal,
      });
    }
  }
  return out;
}

export type FilterDistinctSnapshotRef = {
  current: Record<string, Set<string>>;
};

/**
 * Keeps pivot filter selections in sync with the current `filters` list and row data.
 * When `distinctSnapshotRef` is provided, any **new** distinct values that appear in
 * `rows` since the last sync are merged into the selection (so stale "all values" sets
 * don't hide rows after preview/data updates). Values the user explicitly excluded
 * are not re-added if they were present in the previous snapshot.
 */
export function syncFilterSelectionsWithFilters(
  rows: Record<string, unknown>[],
  filters: string[],
  prev: FilterSelections,
  distinctSnapshotRef?: FilterDistinctSnapshotRef
): FilterSelections {
  const next: FilterSelections = { ...prev };
  const snap = distinctSnapshotRef?.current ?? null;

  for (const f of filters) {
    const distinctNow = new Set<string>();
    for (const r of rows) {
      distinctNow.add(pivotDimensionStringKey(r[f]));
    }
    const lastSnap = snap?.[f] ?? new Set<string>();

    if (next[f] === undefined) {
      next[f] = new Set(distinctNow);
      if (snap) {
        snap[f] = new Set(distinctNow);
      }
      continue;
    }

    if (!distinctSnapshotRef) {
      continue;
    }

    const sel = new Set(next[f]);
    for (const v of distinctNow) {
      if (!lastSnap.has(v)) {
        sel.add(v);
      }
    }
    for (const v of sel) {
      if (!distinctNow.has(v)) {
        sel.delete(v);
      }
    }
    next[f] = sel;
    distinctSnapshotRef.current[f] = new Set(distinctNow);
  }

  for (const k of Object.keys(next)) {
    if (!filters.includes(k)) {
      delete next[k];
      if (snap && k in snap) {
        delete snap[k];
      }
    }
  }
  return next;
}

export function filterPivotRows(
  rows: Record<string, unknown>[],
  filterFields: string[],
  selections: FilterSelections
): Record<string, unknown>[] {
  if (filterFields.length === 0) return rows;
  return rows.filter((r) => {
    for (const f of filterFields) {
      const sel = selections[f];
      if (sel === undefined) continue;
      if (sel.size === 0) return false;
      const v = pivotDimensionStringKey(r[f]);
      if (!sel.has(v)) return false;
    }
    return true;
  });
}

export function collectColKeys(
  rows: Record<string, unknown>[],
  colField: string
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    set.add(pivotDimensionStringKey(r[colField]));
  }
  return [...set].sort(compareTemporalOrLexicalLabels);
}

export function buildPivotTree(
  rows: Record<string, unknown>[],
  config: PivotUiConfig,
  valueSpecs: PivotValueSpec[]
): PivotTree {
  const rowFields = config.rows;
  const colField = config.columns[0] ?? null;
  const colKeys = colField ? collectColKeys(rows, colField) : [];

  if (rowFields.length === 0) {
    const grandTotal = aggregatePivot(rows, valueSpecs, colField, colKeys);
    return { nodes: [], grandTotal };
  }

  const nodes = buildLevel(
    rows,
    rowFields,
    0,
    [],
    colField,
    colKeys,
    valueSpecs,
    config.rowSort
  );
  const grandTotal = aggregatePivot(rows, valueSpecs, colField, colKeys);
  return { nodes, grandTotal };
}

export function buildPivotModel(
  allRows: Record<string, unknown>[],
  config: PivotUiConfig,
  valueSpecs: PivotValueSpec[],
  filterSelections: FilterSelections
): PivotModel {
  const filtered = filterPivotRows(allRows, config.filters, filterSelections);
  const colFieldEffective = config.columns[0] ?? null;
  const colKeys = colFieldEffective
    ? collectColKeys(filtered, colFieldEffective)
    : [];
  const tree = buildPivotTree(filtered, config, valueSpecs);
  return {
    rowFields: config.rows,
    colField: colFieldEffective,
    columnFields: [...config.columns],
    colKeys,
    valueSpecs,
    tree,
    columnFieldTruncated: config.columns.length > 1,
  };
}

export function flattenPivotTree(
  tree: PivotTree,
  collapsed: Set<string>
): PivotFlatRow[] {
  const out: PivotFlatRow[] = [];

  function walk(
    nodes: (PivotGroupNode | PivotLeafNode)[],
    parentExpanded: boolean
  ) {
    for (const n of nodes) {
      if (n.type === 'leaf') {
        if (!parentExpanded) continue;
        out.push({
          kind: 'data',
          depth: n.depth,
          label: n.label,
          pathKey: n.pathKey,
          values: n.values,
        });
        continue;
      }
      const isCollapsed = collapsed.has(n.pathKey);
      if (isCollapsed) {
        out.push({
          kind: 'collapsed',
          depth: n.depth,
          label: n.label,
          pathKey: n.pathKey,
          values: n.subtotal,
        });
      } else {
        out.push({
          kind: 'header',
          depth: n.depth,
          label: n.label,
          pathKey: n.pathKey,
          values: null,
        });
        walk(n.children, true);
        out.push({
          kind: 'subtotal',
          depth: n.depth,
          label: 'Total',
          pathKey: `${n.pathKey}\x1f__sub__`,
          values: n.subtotal,
        });
      }
    }
  }

  walk(tree.nodes, true);

  out.push({
    kind: 'grand',
    depth: 0,
    label: 'Grand total',
    pathKey: '__grand__',
    values: tree.grandTotal,
  });

  return out;
}

export function createInitialPivotConfig(
  allKeys: string[],
  numericKeys: string[],
  defaultRowKeys: string[],
  defaultValueKeys: string[]
): PivotUiConfig {
  const numericSet = new Set(numericKeys);
  const allDims = allKeys.filter((k) => !numericSet.has(k));

  // Default pivot rows: prefer user-selected defaults, but fall back to the
  // first available non-numeric dimension.
  const rowsFromDefaults = defaultRowKeys.filter((k) => allDims.includes(k));
  const rows = rowsFromDefaults.length > 0 ? rowsFromDefaults : allDims.slice(0, 1);

  // Default pivot values: prefer user-selected defaults, but fall back to the
  // first numeric key if none were provided.
  const valuesFromDefaults = defaultValueKeys
    .filter((k) => allKeys.includes(k))
    .map((field) => ({
      id: `meas_${field}`,
      field,
      // If numericSet says it's numeric, sum it; otherwise count it.
      agg: numericSet.has(field) ? ("sum" as PivotAgg) : ("count" as PivotAgg),
    }));

  const values: PivotValueSpec[] =
    valuesFromDefaults.length > 0
      ? valuesFromDefaults
      : (() => {
          const firstNumeric = numericKeys.find((k) => allKeys.includes(k));
          return firstNumeric
            ? [
                {
                  id: `meas_${firstNumeric}`,
                  field: firstNumeric,
                  agg: "sum" as PivotAgg,
                },
              ]
            : [];
        })();

  // `unused` should include everything except what's currently in Rows/Values.
  const usedFields = new Set<string>([...rows, ...values.map((v) => v.field)]);
  const unused = allKeys.filter((k) => !usedFields.has(k));

  const rowSort: PivotUiConfig["rowSort"] =
    values.length > 0
      ? {
          byValueSpecId: values[0]!.id,
          direction: "desc",
          primary: "measure",
        }
      : undefined;
  return {
    filters: [],
    columns: [],
    rows,
    values,
    unused,
    rowSort,
  };
}

/** Normalize config so every key appears in exactly one bucket (repair duplicates). */
export function normalizePivotConfig(
  allKeys: string[],
  config: PivotUiConfig
): PivotUiConfig {
  const seen = new Set<string>();
  const take = (arr: string[]) => arr.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const filters = take([...config.filters]);
  const columns = take([...config.columns]);
  const rows = take([...config.rows]);
  const vals = config.values.filter((v) => {
    if (seen.has(v.field)) return false;
    seen.add(v.field);
    return true;
  });
  const unused = take([...config.unused]);
  for (const k of allKeys) {
    if (!seen.has(k)) unused.push(k);
  }

  let rowSort = config.rowSort;
  if (rowSort) {
    if (rowSort.primary === "rowLabel") {
      // keep row-label sort without requiring a measure id
    } else {
      const stillExists =
        rowSort.byValueSpecId &&
        vals.some((v) => v.id === rowSort!.byValueSpecId);
      if (!stillExists) {
        rowSort =
          vals.length > 0
            ? {
                byValueSpecId: vals[0]!.id,
                direction: rowSort.direction,
                primary: "measure",
              }
            : undefined;
      }
    }
  }

  return { filters, columns, rows, values: vals, unused, rowSort };
}
