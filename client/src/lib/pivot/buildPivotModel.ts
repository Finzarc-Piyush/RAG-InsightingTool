import { parseNumericCell } from '@/lib/formatAnalysisNumber';
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
    const slice = rows.filter((r) => String(r[colField] ?? '') === ck);
    for (const spec of valueSpecs) {
      matrixValues[ck][spec.id] = applyAgg(slice, spec);
    }
  }
  return { flatValues: null, matrixValues };
}

function groupByField(
  rows: Record<string, unknown>[],
  field: string
): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = String(r[field] ?? '');
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

function sortedKeys(map: Map<string, Record<string, unknown>[]>): string[] {
  return [...map.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function isoWeekStartUtc(isoYear: number, isoWeek: number): number {
  // ISO week starts on Monday. ISO week 1 is the week containing Jan 4th.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // Sunday => 7
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));
  const mondayTarget = new Date(mondayWeek1);
  mondayTarget.setUTCDate(mondayWeek1.getUTCDate() + (isoWeek - 1) * 7);
  return mondayTarget.getTime();
}

function parseTemporalFacetKeyForSort(key: string): number | null {
  const s = String(key ?? "").trim();
  if (!s) return null;

  let m: RegExpMatchArray | null;

  // Year: YYYY
  if (/^\d{4}$/.test(s)) {
    const year = Number(s);
    return Date.UTC(year, 0, 1);
  }

  // Month: YYYY-MM
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return Date.UTC(year, month - 1, 1);
  }

  // Quarter: YYYY-Qn
  m = s.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    const year = Number(m[1]);
    const q = Number(m[2]);
    const month = (q - 1) * 3;
    return Date.UTC(year, month, 1);
  }

  // Half-year: YYYY-Hn
  m = s.match(/^(\d{4})-H([1-2])$/);
  if (m) {
    const year = Number(m[1]);
    const h = Number(m[2]);
    const month = (h - 1) * 6;
    return Date.UTC(year, month, 1);
  }

  // ISO week: YYYY-Www
  m = s.match(/^(\d{4})-W(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const wk = Number(m[2]);
    if (wk >= 1 && wk <= 53) return isoWeekStartUtc(year, wk);
  }

  // Day: YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return Date.UTC(year, month - 1, day);
    }
  }

  return null;
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
  if (rowSort?.byValueSpecId) {
    const chosen = valueSpecs.find((v) => v.id === rowSort.byValueSpecId);
    if (chosen) {
      keys = [...groups.keys()].sort((a, b) => {
        const subA = groups.get(a)!;
        const subB = groups.get(b)!;
        const totalA = applyAgg(subA, chosen);
        const totalB = applyAgg(subB, chosen);

        if (totalA === totalB) {
          const ta = parseTemporalFacetKeyForSort(a);
          const tb = parseTemporalFacetKeyForSort(b);
          if (ta != null && tb != null) return ta - tb;
          return a.localeCompare(b, undefined, { numeric: true });
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

export function syncFilterSelectionsWithFilters(
  rows: Record<string, unknown>[],
  filters: string[],
  prev: FilterSelections
): FilterSelections {
  const next: FilterSelections = { ...prev };
  for (const f of filters) {
    if (next[f] !== undefined) continue;
    const s = new Set<string>();
    for (const r of rows) {
      s.add(String(r[f] ?? ''));
    }
    next[f] = s;
  }
  for (const k of Object.keys(next)) {
    if (!filters.includes(k)) {
      delete next[k];
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
      const v = String(r[f] ?? '');
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
    set.add(String(r[colField] ?? ''));
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
    values.length > 0 ? { byValueSpecId: values[0]!.id, direction: "desc" } : undefined;
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
    const stillExists = vals.some((v) => v.id === rowSort!.byValueSpecId);
    if (!stillExists) {
      rowSort =
        vals.length > 0
          ? { byValueSpecId: vals[0]!.id, direction: rowSort.direction }
          : undefined;
    }
  }

  return { filters, columns, rows, values: vals, unused, rowSort };
}
