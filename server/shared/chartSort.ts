/**
 * Single shared authority for ORDERING chart rows (bar / column / stacked /
 * grouped). Pure — no imports — so it runs byte-identically on the server
 * (`chartGenerator.processChartData`) and the client (`useChartSort`, pivot
 * preview). It absorbs the temporal-label comparator that used to live in
 * `client/src/lib/temporalAxisSort.ts` (now a one-line re-export of this file)
 * so there is exactly ONE copy of the chronological-key logic in the tree.
 *
 * Scope is ORDER only. GRAIN (day/week/month/quarter) is governed elsewhere by
 * `temporalGrainAuthority` (invariant #11); this module never decides grain.
 *
 * See docs/decisions/centralized-chart-sort.md.
 */

export type ChartSortBy = "value" | "category";
export type ChartSortDirection = "asc" | "desc";

/**
 * How a categorical bar/column chart is ordered.
 * - `by: "value"`    → order by the measured value (sum across series for
 *                      multi-series). `desc` = tallest first (the historic
 *                      default), `asc` = smallest first (bottom-N).
 * - `by: "category"` → order by the x-axis itself: numeric → 0→100, dates →
 *                      chronological, buckets → 0-10/10-20…, else A→Z.
 *
 * The runtime validator (`chartSortSpecSchema`) lives in
 * server/shared/schema/charts.ts and MUST keep this shape — they are
 * structurally linked, not imported, to keep this module dependency-free.
 */
export interface ChartSortSpec {
  by: ChartSortBy;
  direction: ChartSortDirection;
}

// ---------------------------------------------------------------------------
// Temporal label parsing — moved verbatim from client/src/lib/temporalAxisSort.ts
// ---------------------------------------------------------------------------

function isoWeekStartUtc(isoYear: number, isoWeek: number): number {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));
  const mondayTarget = new Date(mondayWeek1);
  mondayTarget.setUTCDate(mondayWeek1.getUTCDate() + (isoWeek - 1) * 7);
  return mondayTarget.getTime();
}

/**
 * Sortable instant (UTC ms) for the CANONICAL temporal key shapes ONLY —
 * YYYY, YYYY-MM, YYYY-Qn, YYYY-Hn, YYYY-Www, YYYY-MM-DD. No `Date.parse`
 * fallback here, so bare numbers ("100") and ambiguous ranges ("10-20") are
 * NOT swallowed as dates — the chart-sort comparator relies on this.
 */
function canonicalTemporalKey(label: string): number | null {
  const s = String(label ?? "").trim();
  if (!s) return null;

  let m: RegExpMatchArray | null;

  if (/^\d{4}$/.test(s)) {
    return Date.UTC(Number(s), 0, 1);
  }

  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return Date.UTC(year, month - 1, 1);
  }

  m = s.match(/^(\d{4})-Q([1-4])$/);
  if (m) {
    const year = Number(m[1]);
    const q = Number(m[2]);
    return Date.UTC(year, (q - 1) * 3, 1);
  }

  m = s.match(/^(\d{4})-H([1-2])$/);
  if (m) {
    const year = Number(m[1]);
    const h = Number(m[2]);
    return Date.UTC(year, (h - 1) * 6, 1);
  }

  m = s.match(/^(\d{4})-W(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const wk = Number(m[2]);
    if (wk >= 1 && wk <= 53) return isoWeekStartUtc(year, wk);
  }

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

/**
 * Parse sortable instant (UTC ms) for known temporal facet / ISO-like labels.
 * Canonical key shapes first, then a permissive `Date.parse` fallback — kept
 * for the existing callers (pivot, chart renderers). The chart-sort comparator
 * uses `canonicalTemporalKey` directly + a numeric branch so bare numbers never
 * reach this fallback.
 */
export function parseTemporalLabelSortKey(label: string): number | null {
  const canonical = canonicalTemporalKey(label);
  if (canonical != null) return canonical;
  const s = String(label ?? "").trim();
  if (!s) return null;
  const isoTry = Date.parse(s);
  return Number.isNaN(isoTry) ? null : isoTry;
}

export function compareTemporalOrLexicalLabels(a: string, b: string): number {
  const ta = parseTemporalLabelSortKey(a);
  const tb = parseTemporalLabelSortKey(b);
  if (ta != null && tb != null) return ta - tb;
  if (ta != null) return -1;
  if (tb != null) return 1;
  return a.localeCompare(b, undefined, { numeric: true });
}

// ---------------------------------------------------------------------------
// Value / category primitives
// ---------------------------------------------------------------------------

function isNullish(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === "string" && v.trim() === "")
  );
}

const PURE_NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

/** A value that IS a plain number (or a numeric string like "25", "-3.5"). */
function asPureNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (PURE_NUMBER_RE.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

const BUCKET_LEAD_RE = /^[<>≤≥~\s]*(-?\d+(?:\.\d+)?)/;

/**
 * Ordering key for a bucket-ish label by its CONCEPTUAL position:
 * "0-10"→0, "10-20"→10 (lower bound). Open-ended bands order to the extreme:
 * "<10"/"≤10" → -Infinity (unbounded-low, sorts first), ">100"/"≥100"/"100+" →
 * +Infinity (unbounded-high, sorts last). Returns null when no number is found.
 */
function bucketLeadingNumber(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = s.match(BUCKET_LEAD_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (/^[<≤]/.test(s)) return -Infinity; // "<10" — everything below
  if (/^[>≥]/.test(s)) return Infinity; // ">100" — everything above
  if (/\+\s*$/.test(s)) return Infinity; // "100+" — and above
  return n;
}

/** Coerce a cell to a finite number, or NaN. Handles "1,000" and blanks. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string") {
    const s = v.replace(/,/g, "").trim();
    if (s === "") return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Ascending comparison of two NON-null category values. Precedence (ORDER IS
 * LOAD-BEARING):
 *   1. Date instances → chronological.
 *   2. Pure numbers ("2" < "10" < "100", incl. negatives/decimals and bare
 *      years) → numeric. MUST precede temporal: the temporal parser's
 *      `Date.parse` fallback would otherwise swallow bare integers as dates
 *      (e.g. "100" → year 100 AD), misordering the headline age axis.
 *   3. CANONICAL temporal keys (YYYY-Qn, YYYY-MM, ISO date…) → chronological.
 *      Strict (no Date.parse), so "10-20" is not misread as a date.
 *   4. Numeric buckets ("0-10" < "10-20"; "<10" first, "100+" last).
 *   5. Loose dates ("March 2023") via the permissive Date.parse fallback.
 *   6. Lexical (numeric collation).
 */
function categoryCompareCore(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) {
    const ad = a.getTime();
    const bd = b.getTime();
    if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
  }

  const as = String(a).trim();
  const bs = String(b).trim();

  const an = asPureNumber(a);
  const bn = asPureNumber(b);
  if (an != null && bn != null) return an - bn;

  const ak = canonicalTemporalKey(as);
  const bk = canonicalTemporalKey(bs);
  if (ak != null && bk != null) return ak - bk;

  const ab = bucketLeadingNumber(a);
  const bb = bucketLeadingNumber(b);
  if (ab != null && bb != null) {
    if (ab !== bb) return ab < bb ? -1 : 1; // < / 1 keeps ±Infinity safe
    return as.localeCompare(bs, undefined, { numeric: true });
  }

  const at = parseTemporalLabelSortKey(as);
  const bt = parseTemporalLabelSortKey(bs);
  if (at != null && bt != null) return at - bt;

  return as.localeCompare(bs, undefined, { numeric: true });
}

/**
 * Public ascending category comparator with nulls/blanks sorted LAST. Used as
 * the value-tie-break and by ascending callers/tests. Direction (desc) is the
 * caller's job (see `applyChartSort`) so nulls can stay last in both directions.
 */
export function compareCategory(a: unknown, b: unknown): number {
  const na = isNullish(a);
  const nb = isNullish(b);
  if (na && nb) return 0;
  if (na) return 1;
  if (nb) return -1;
  return categoryCompareCore(a, b);
}

/**
 * The chart's value for a row. Multi-series (seriesKeys present) → SUM across
 * series (the natural "tallest stacked / biggest group" value, replacing the
 * old first-series-only behavior). Single-series → the y column. NaN when the
 * row carries no finite measure.
 */
export function rowValue(
  row: Record<string, unknown>,
  yCol: string,
  seriesKeys?: string[],
): number {
  if (seriesKeys && seriesKeys.length > 0) {
    let sum = 0;
    let any = false;
    for (const k of seriesKeys) {
      const n = toNumber(row[k]);
      if (Number.isFinite(n)) {
        sum += n;
        any = true;
      }
    }
    return any ? sum : NaN;
  }
  return toNumber(row[yCol]);
}

// ---------------------------------------------------------------------------
// Default resolution + selection + ordering
// ---------------------------------------------------------------------------

/**
 * Does this x-axis look inherently ordered (so a fresh chart should default to
 * category order, e.g. "survived by age" → 0→100)? True when ≥85% of the
 * distinct non-null values are dates, temporal keys, pure numbers or numeric
 * buckets. Nominal axes (brands, ASMs) return false → keep value-desc default.
 */
export function detectAxisOrdered(values: Iterable<unknown>): boolean {
  const distinct = new Set<string>();
  let ordered = 0;
  for (const v of values) {
    if (isNullish(v)) continue;
    const key = v instanceof Date ? `d:${v.getTime()}` : String(v).trim();
    if (distinct.has(key)) continue;
    distinct.add(key);
    const isOrdered =
      v instanceof Date ||
      parseTemporalLabelSortKey(String(v).trim()) != null ||
      asPureNumber(v) != null ||
      bucketLeadingNumber(v) != null;
    if (isOrdered) ordered++;
  }
  const total = distinct.size;
  if (total < 2) return false;
  return ordered / total >= 0.85;
}

/**
 * Resolve the EFFECTIVE sort for a chart, honoring (in priority order):
 *   1. an explicit `spec.sort` (user choice / previously baked default),
 *   2. the legacy `spec.sortDirection` alias → `{ by: "value", direction }`,
 *   3. temporal x → chronological (`{ by: "category", direction: "asc" }`),
 *   4. inherently-ordered x → category-ascending (the "auto axis-order" rule),
 *   5. otherwise the historic default `{ by: "value", direction: "desc" }`.
 */
export function resolveSort(
  input: { sort?: ChartSortSpec | null; sortDirection?: ChartSortDirection | null },
  ctx: { xValues?: Iterable<unknown>; isTemporalX?: boolean },
): ChartSortSpec {
  if (input.sort && input.sort.by && input.sort.direction) return input.sort;
  if (input.sortDirection) return { by: "value", direction: input.sortDirection };
  if (ctx.isTemporalX) return { by: "category", direction: "asc" };
  if (ctx.xValues && detectAxisOrdered(ctx.xValues)) {
    return { by: "category", direction: "asc" };
  }
  return { by: "value", direction: "desc" };
}

/**
 * Pick the top-N rows BY VALUE (descending), preserving input order among ties
 * and pushing finite values ahead of NaN. This is the SELECTION step and is
 * deliberately decoupled from display ORDER (see `applyChartSort`): an
 * "axis-asc + maxRows:10" chart shows the 10 biggest cohorts ordered by axis,
 * never the 10 smallest categories.
 */
export function selectTopNByValue<T extends Record<string, unknown>>(
  rows: T[],
  n: number,
  opts: { yCol: string; seriesKeys?: string[] },
): T[] {
  if (!(n > 0) || rows.length <= n) return rows.slice();
  const withVal = rows.map((r, i) => ({ r, i, v: rowValue(r, opts.yCol, opts.seriesKeys) }));
  withVal.sort((a, b) => {
    const af = Number.isFinite(a.v);
    const bf = Number.isFinite(b.v);
    if (!af && !bf) return a.i - b.i;
    if (!af) return 1;
    if (!bf) return -1;
    if (b.v !== a.v) return b.v - a.v;
    return a.i - b.i;
  });
  return withVal.slice(0, n).map((x) => x.r);
}

/**
 * Pick the bottom-N rows BY VALUE (ascending), preserving input order among ties
 * and pushing finite values ahead of NaN — so "Bottom N" selects the N smallest
 * *finite* values rather than N blank rows. Mirror of `selectTopNByValue`; the
 * SELECTION step, decoupled from display ORDER (see `applyChartSort`'s `limit`).
 */
export function selectBottomNByValue<T extends Record<string, unknown>>(
  rows: T[],
  n: number,
  opts: { yCol: string; seriesKeys?: string[] },
): T[] {
  if (!(n > 0) || rows.length <= n) return rows.slice();
  const withVal = rows.map((r, i) => ({ r, i, v: rowValue(r, opts.yCol, opts.seriesKeys) }));
  withVal.sort((a, b) => {
    const af = Number.isFinite(a.v);
    const bf = Number.isFinite(b.v);
    if (!af && !bf) return a.i - b.i;
    if (!af) return 1; // NaN last — never selected as "smallest"
    if (!bf) return -1;
    if (a.v !== b.v) return a.v - b.v; // ascending
    return a.i - b.i;
  });
  return withVal.slice(0, n).map((x) => x.r);
}

/** Order rows by the category axis (direction-aware, nulls always last). */
function sortByCategory<T extends Record<string, unknown>>(
  rows: T[],
  direction: ChartSortDirection,
  xCol: string,
): T[] {
  const dirMul = direction === "desc" ? -1 : 1;
  return rows.slice().sort((ra, rb) => {
    const va = ra[xCol];
    const vb = rb[xCol];
    const na = isNullish(va);
    const nb = isNullish(vb);
    if (na && nb) return 0;
    if (na) return 1; // nulls always last, both directions
    if (nb) return -1;
    return dirMul * categoryCompareCore(va, vb);
  });
}

/** Order rows by value (direction-aware; NaN/blank last; axis-ascending tie-break). */
function sortByValue<T extends Record<string, unknown>>(
  rows: T[],
  direction: ChartSortDirection,
  xCol: string,
  yCol: string,
  seriesKeys?: string[],
): T[] {
  const dirMul = direction === "desc" ? -1 : 1;
  return rows.slice().sort((ra, rb) => {
    const va = rowValue(ra, yCol, seriesKeys);
    const vb = rowValue(rb, yCol, seriesKeys);
    const na = !Number.isFinite(va);
    const nb = !Number.isFinite(vb);
    if (na && nb) return compareCategory(ra[xCol], rb[xCol]);
    if (na) return 1;
    if (nb) return -1;
    if (va !== vb) return dirMul * (va - vb);
    return compareCategory(ra[xCol], rb[xCol]); // deterministic tie-break
  });
}

/**
 * THE one ordering function. Returns a NEW array; the input is never mutated.
 * `seriesKeys` (legend/stack order) is never touched — only rows are reordered.
 *
 * `limit` is the explicit user-driven Top-N / Bottom-N selection. It runs FIRST
 * and ALWAYS selects by value, fully decoupled from the display `sort`:
 *  - `{mode:'top', n:10}`    → the 10 biggest by value, then ordered by `sort`.
 *  - `{mode:'bottom', n:10}` → the 10 smallest (finite) by value, then by `sort`.
 *  So "Top 10 + axis-asc" shows the 10 biggest displayed by axis, and
 *  "Bottom 10 + value-desc" shows the 10 smallest displayed tallest-first.
 *
 * `maxRows` is the legacy auto-cap (inline card / server). Its semantics differ
 * by mode and are left untouched:
 *  - VALUE sort → order by value in the chosen direction, then take the first N.
 *    So `value/desc + maxRows` = the best N (top-N), `value/asc + maxRows` = the
 *    worst N (bottom-N) — preserving the MW3 management-by-exception behavior.
 *  - CATEGORY sort → select the most-significant N BY VALUE first, then order
 *    that set by the axis. So `category/asc + maxRows:10` shows the 10 biggest
 *    cohorts ordered by axis, never the 10 smallest categories.
 *
 * When both are present `limit` narrows first, then `maxRows` caps — they compose
 * safely, though callers use one or the other.
 */
export function applyChartSort<T extends Record<string, unknown>>(
  rows: T[],
  sort: ChartSortSpec,
  opts: {
    xCol: string;
    yCol: string;
    seriesKeys?: string[];
    maxRows?: number;
    limit?: { mode: "top" | "bottom"; n: number };
    isTemporalX?: boolean;
  },
): T[] {
  const { xCol, yCol, seriesKeys, limit } = opts;

  // Explicit Top-N / Bottom-N selection runs FIRST, by value, regardless of the
  // display sort below (see JSDoc). `rowValue` sums across seriesKeys, so a
  // multi-series bar's Top-N ranks by stacked total — consistent with how sort
  // already ranks multi-series bars.
  let working: T[] = rows;
  if (limit && limit.n > 0 && working.length > limit.n) {
    working =
      limit.mode === "bottom"
        ? selectBottomNByValue(working, limit.n, { yCol, seriesKeys })
        : selectTopNByValue(working, limit.n, { yCol, seriesKeys });
  }

  const cap = opts.maxRows && opts.maxRows > 0 ? opts.maxRows : 0;

  if (sort.by === "value") {
    const sorted = sortByValue(working, sort.direction, xCol, yCol, seriesKeys);
    return cap && sorted.length > cap ? sorted.slice(0, cap) : sorted;
  }

  // category sort: cap to the most-significant N (by value) BEFORE ordering by axis.
  if (cap && working.length > cap) {
    working = selectTopNByValue(working, cap, { yCol, seriesKeys });
  }
  return sortByCategory(working, sort.direction, xCol);
}
