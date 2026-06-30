/**
 * chartValueSanitize.ts — the SINGLE authority for what is allowed to reach a
 * native pptxgenjs `addChart` call.
 *
 * pptxgenjs serializes whatever values / labels / series names it is given into
 * BOTH the chart cache XML (`ppt/charts/chart*.xml`) and the embedded workbook
 * (`ppt/embeddings/*.xlsx`). If any of these is non-finite (`NaN`/`Infinity`) or
 * an empty text node (empty category label / empty series name), PowerPoint flags
 * the file as corrupt ("found a problem with content … Repair") and DROPS the
 * offending chart — which is why some slides render blank in the editor while the
 * thumbnail still shows the card. Upstream `pivotSeries`/`scatterSeries` happen to
 * coerce numbers today, but that contract is incidental and invisible; this module
 * makes it EXPLICIT and enforced at the boundary (and is the only place the pie
 * path's one-off finiteness guard lives now, so there is no drift).
 *
 * Pure leaf module. The numeric coercion delegates to `numberCoercion.toFiniteNumber`
 * so there is exactly one numeric coercer underneath.
 */
import { toFiniteNumber } from "../../numberCoercion.js";

/** Placeholder for an empty/blank category label (never drop — dropping a
 *  category misaligns values vs labels, a different corruption class). */
export const EMPTY_LABEL_PLACEHOLDER = "—";

/** Finite-or-0. The single coercion for every native chart VALUE. */
export function finiteOrZero(v: unknown): number {
  return toFiniteNumber(v) ?? 0;
}

/**
 * Sanitize one native series' values to a finite[] of EQUAL length. We coerce
 * non-finite/null → 0 rather than dropping, because the value array is aligned
 * positionally to the category labels — dropping a cell would shift every later
 * category and produce a cat/val count mismatch (corrupt chart XML).
 */
export function sanitizeValues(values: ReadonlyArray<number | null | undefined>): number[] {
  return values.map((v) => finiteOrZero(v));
}

/** NaN-safe max-abs (seed 0). Replaces the inline `reduce(Math.max(Math.abs))`
 *  in formatCodeFor so a stray non-finite can't poison the value-axis format. */
export function maxFiniteAbs(values: ReadonlyArray<number>): number {
  let max = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      const a = Math.abs(v);
      if (a > max) max = a;
    }
  }
  return max;
}

/** Non-empty display label; empty/whitespace/null → the placeholder. */
export function safeLabel(v: unknown): string {
  const s = v == null ? "" : String(v).trim();
  return s.length > 0 ? s : EMPTY_LABEL_PLACEHOLDER;
}

/** Non-empty series name; empty → fallback (pptxgenjs needs a non-empty series
 *  text node or it emits a malformed `<c:tx>`). */
export function safeSeriesName(v: unknown, fallback = "Series"): string {
  const s = v == null ? "" : String(v).trim();
  return s.length > 0 ? s : fallback;
}

/**
 * True when a native cartesian (bar/line/area) chart would be empty or
 * meaningless after sanitization: no series, no categories, or every value
 * across every series is exactly 0. The caller returns `false` for these so the
 * renderer draws a visible "unavailable" placeholder instead of an empty chart
 * (which PowerPoint would flag).
 */
export function isDegenerateNative(args: {
  categories: ReadonlyArray<string>;
  series: ReadonlyArray<{ values: ReadonlyArray<number> }>;
}): boolean {
  if (args.series.length === 0) return true;
  if (args.categories.length === 0) return true;
  const anyNonZero = args.series.some((s) => s.values.some((v) => v !== 0));
  return !anyNonZero;
}
