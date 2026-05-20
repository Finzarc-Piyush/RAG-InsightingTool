/**
 * Wave W61-references-scan · downstream-reference counter for the admin
 * delete-entry confirmation. Given a semantic-model entry name (e.g.
 * `"net_sales_value"`) and a heterogeneous array of persisted chart specs
 * (v1 ChartSpec + v2 ChartSpecV2), returns how many distinct charts and
 * how many field-positions reference the name.
 *
 * The follow-on W61-delete-entry wave consumes this scanner to render a
 * "removing this metric will break N charts that reference it" prompt
 * before the destructive operation. Without the scanner the delete is
 * still functionally correct but loses the safety-net UX.
 *
 * Why exact-identifier equality, not substring or fuzzy matching:
 *   - Substring matching would false-positive (e.g. "sales" inside the
 *     metric name "net_sales_value" would also match the unrelated
 *     "sales_volume" — too noisy to be load-bearing for a destructive
 *     prompt).
 *   - SQL-like `transform.filter.expr` / `transform.calculate.expr`
 *     strings are deliberately skipped for the same reason; a future
 *     enhancement could add an opt-in expression-substring mode.
 *
 * Why support both v1 and v2 chart shapes at runtime:
 *   - The chat document types `doc.charts: ChartSpec[]` (v1) at the
 *     type-system level but the runtime values may contain v2 specs
 *     after the planned v1→v2 migration. The schema's `isChartSpecV2`
 *     runtime discriminator (`value.version === 2 && typeof value.mark
 *     === "string"`) is the safety check; this scanner uses it.
 *
 * Why the top-level function accepts `ReadonlyArray<unknown>`:
 *   - The caller (the future W61-references-endpoint handler) hands us
 *     whatever lives at `doc.charts`; defensive `typeof === "object"`
 *     guards inside the scanner mean a stray null / primitive / malformed
 *     entry doesn't throw — it's silently skipped, which is the right
 *     UX for a "how many" question (an unreadable chart can't be
 *     destructively-affected by removing a metric we don't know it
 *     references).
 */

import {
  isChartSpecV2,
  type ChartSpec,
  type ChartSpecV2,
} from "../../shared/schema.js";

export interface SemanticModelReferenceCount {
  /** Number of distinct charts that contain at least one match. */
  chartCount: number;
  /** Total field-position matches across all charts. A single chart with `x === name && y === name` contributes 2. */
  totalOccurrences: number;
}

/**
 * Walk every known string-field location on a v1 ChartSpec and return
 * the count of positions whose value `=== name`. Empty / undefined
 * `name` always returns 0 so a malformed semantic-model entry can't
 * accidentally match every chart.
 */
export function countReferencesInChartSpec(
  chart: ChartSpec,
  name: string,
): number {
  if (!name) return 0;
  let n = 0;
  if (chart.x === name) n += 1;
  if (chart.y === name) n += 1;
  if (chart.z === name) n += 1;
  if (chart.seriesColumn === name) n += 1;
  if (chart.y2 === name) n += 1;
  if (Array.isArray(chart.y2Series)) {
    for (const s of chart.y2Series) if (s === name) n += 1;
  }
  const prov = chart._agentProvenance;
  if (prov) {
    if (Array.isArray(prov.columnsUsed)) {
      for (const c of prov.columnsUsed) if (c === name) n += 1;
    }
    if (Array.isArray(prov.rangeFilters)) {
      for (const f of prov.rangeFilters) if (f.column === name) n += 1;
    }
  }
  return n;
}

/**
 * Walk every known `.field` location on a v2 ChartSpecV2 encoding +
 * transform discriminated union. Skips `transform.filter.expr` and
 * `transform.calculate.expr` — substring matching SQL-like strings
 * would generate false positives (see module doc-comment).
 */
export function countReferencesInChartSpecV2(
  chart: ChartSpecV2,
  name: string,
): number {
  if (!name) return 0;
  let n = 0;
  const enc = chart.encoding;
  if (enc.x?.field === name) n += 1;
  if (enc.y?.field === name) n += 1;
  if (enc.x2?.field === name) n += 1;
  if (enc.y2?.field === name) n += 1;
  if (Array.isArray(enc.y2Series)) {
    for (const c of enc.y2Series) if (c.field === name) n += 1;
  }
  if (enc.color?.field === name) n += 1;
  if (enc.size?.field === name) n += 1;
  if (enc.shape?.field === name) n += 1;
  if (enc.pattern?.field === name) n += 1;
  // `encoding.opacity` is a union of channel | `{ value: number }`; the
  // `.field` access is undefined-safe on the literal-value branch.
  if (enc.opacity && "field" in enc.opacity && enc.opacity.field === name) {
    n += 1;
  }
  if (enc.facetRow?.field === name) n += 1;
  if (enc.facetCol?.field === name) n += 1;
  if (enc.detail?.field === name) n += 1;
  if (enc.text?.field === name) n += 1;
  if (enc.order?.field === name) n += 1;
  if (Array.isArray(enc.tooltip)) {
    for (const t of enc.tooltip) if (t.field === name) n += 1;
  }
  if (Array.isArray(chart.transform)) {
    for (const t of chart.transform) {
      if (t.type === "aggregate") {
        for (const g of t.groupby) if (g === name) n += 1;
        for (const op of t.ops) if (op.field === name) n += 1;
      } else if (t.type === "fold") {
        for (const f of t.fields) if (f === name) n += 1;
      } else if (t.type === "bin") {
        if (t.field === name) n += 1;
      } else if (t.type === "window") {
        for (const op of t.ops) if (op.field === name) n += 1;
        if (Array.isArray(t.groupby)) {
          for (const g of t.groupby) if (g === name) n += 1;
        }
        if (Array.isArray(t.sort)) {
          for (const s of t.sort) if (s === name) n += 1;
        }
      } else if (t.type === "regression") {
        if (t.on === name) n += 1;
      }
      // `filter` / `calculate` deliberately skipped (SQL-expression noise).
    }
  }
  const prov = chart._agentProvenance;
  if (prov) {
    if (Array.isArray(prov.columnsUsed)) {
      for (const c of prov.columnsUsed) if (c === name) n += 1;
    }
    if (Array.isArray(prov.rangeFilters)) {
      for (const f of prov.rangeFilters) if (f.column === name) n += 1;
    }
  }
  return n;
}

/**
 * Walk a heterogeneous array (mixed v1 + v2 + defensive junk) and
 * return the aggregate `{ chartCount, totalOccurrences }`. Non-object
 * items are silently skipped.
 */
export function countSemanticModelReferences(
  name: string,
  charts: ReadonlyArray<unknown>,
): SemanticModelReferenceCount {
  let chartCount = 0;
  let totalOccurrences = 0;
  if (!name) return { chartCount, totalOccurrences };
  for (const c of charts) {
    if (typeof c !== "object" || c === null) continue;
    const hits = isChartSpecV2(c)
      ? countReferencesInChartSpecV2(c, name)
      : countReferencesInChartSpec(c as ChartSpec, name);
    if (hits > 0) {
      chartCount += 1;
      totalOccurrences += hits;
    }
  }
  return { chartCount, totalOccurrences };
}
