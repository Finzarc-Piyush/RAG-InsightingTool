/**
 * Width-aware X-axis label budget.
 *
 * The old fixed `MAX_X_AXIS_LABELS = 10` was a one-size cap: it under-labelled
 * wide charts (a 900px modal that could legibly show ~25 short labels still
 * showed 10) and risked crowding narrow ones. The "10 or 11" the user sees is
 * this constant plus the always-appended last tick.
 *
 * This mirrors the density-aware Y-axis budget (`yAxisTickCount.ts`): compute
 * how many tick LABELS fit in the available axis pixel width given the label
 * text lengths, font size, and rotation — never a magic number. The number of
 * data points is never reduced; only the *labels* are thinned, and only as
 * much as the available width demands.
 *
 * Footprint model (no DOM measurement; the char-width estimate matches
 * `labelCollision.ts` so the two stay consistent):
 *   - Horizontal labels (rotation ~0): each needs ≈ textWidth + gap px.
 *     Longer labels ⇒ fewer fit; short labels ("2021", "Q1") ⇒ many fit.
 *   - Rotated labels (e.g. -45° in the recharts renderer): adjacent slanted
 *     labels clear each other once their anchors are ≥ labelHeight/sin(θ)
 *     apart — a footprint driven by label HEIGHT, not text length, so far more
 *     labels fit than when horizontal.
 */

/** Always show at least the first and last tick. */
export const MIN_X_AXIS_LABELS = 2;

/**
 * Pathological-DOM safety guard ONLY — never a UX target. It exists so that
 * 1–2 char labels on an absurdly wide axis can't request thousands of <text>
 * nodes. The real upper bound on a normal chart is the data-point count (you
 * can't label more buckets than exist) and the no-overlap pixel density — both
 * cap first, well below this. Set high enough that it never governs a real chart.
 */
export const ABS_MAX_X_AXIS_LABELS = 200;

/** Fallback budget used only when the axis pixel width is unknown. */
export const DEFAULT_MAX_X_AXIS_LABELS = 10;

/**
 * Back-compat constant. Prefer the width-aware `maxXAxisLabels(...)`. Retained
 * as the default `max` param for `pickEvenlySpacedTicks` / `echartsLabelInterval`
 * so callers that genuinely cannot measure width keep the previous behavior, and
 * for the `Math.max(2, MAX_X_AXIS_LABELS - 1)` arithmetic in the ECharts path.
 */
export const MAX_X_AXIS_LABELS = DEFAULT_MAX_X_AXIS_LABELS;

// SF/Inter average glyph advance ≈ 0.55–0.6 × fontSize; 0.6 biases conservative.
const CHAR_WIDTH_FACTOR = 0.6;
const LINE_HEIGHT_FACTOR = 1.2;
const MIN_GAP_PX = 6;
const DEFAULT_FONT_PX = 11;
const FALLBACK_LABEL_CHARS = 6;

export interface XAxisLabelBudgetOpts {
  /**
   * Available pixel width of the x-axis band (e.g. visx `innerWidth`, or a
   * measured container width for recharts). When omitted/invalid the budget
   * falls back to `DEFAULT_MAX_X_AXIS_LABELS`.
   */
  axisWidthPx?: number;
  /** The label values that will render — their text length drives the budget. */
  labels?: ReadonlyArray<unknown>;
  /** Fallback typical label length (chars) when `labels` is not provided. */
  avgLabelChars?: number;
  /** Axis label font size in px (default 11). */
  fontSizePx?: number;
  /** Label rotation in degrees (0 = horizontal; e.g. -45 for recharts bars). */
  rotationDeg?: number;
  /** Minimum gap between adjacent labels in px (default 6). */
  minGapPx?: number;
  /**
   * Number of distinct x data points / categories. The budget is never larger
   * than this — you can't label more buckets than exist, so a 7-point series is
   * never thinned no matter how wide the axis. When omitted, falls back to
   * `labels.length`; when neither is given, width/density governs alone.
   */
  dataPointCount?: number;
}

/** Length (in chars) of the WIDEST label — the budget must guarantee it fits. */
function widestLabelChars(
  labels: ReadonlyArray<unknown> | undefined,
  fallback: number
): number {
  if (!labels || labels.length === 0) return fallback;
  let max = 0;
  for (const l of labels) {
    const len = String(l ?? '').length;
    if (len > max) max = len;
  }
  return max > 0 ? max : fallback;
}

/**
 * Maximum number of x-axis tick labels that fit legibly in `axisWidthPx`.
 *
 * The result is `min(fitByWidth, dataPointCount, ABS_MAX_X_AXIS_LABELS)`, floored
 * at `MIN_X_AXIS_LABELS` — i.e. governed by no-overlap pixel density and the data
 * count, NOT a magic number. Returns `DEFAULT_MAX_X_AXIS_LABELS` only when width
 * is unknown/invalid so callers that can't measure keep working.
 */
export function maxXAxisLabels(opts: XAxisLabelBudgetOpts = {}): number {
  const { axisWidthPx } = opts;
  if (
    typeof axisWidthPx !== 'number' ||
    !Number.isFinite(axisWidthPx) ||
    axisWidthPx <= 0
  ) {
    return DEFAULT_MAX_X_AXIS_LABELS;
  }

  // Every optional numeric input is validated for finiteness (a stray NaN /
  // Infinity must never propagate to the result — see the contract above).
  const fontSizePx =
    Number.isFinite(opts.fontSizePx) && (opts.fontSizePx as number) > 0
      ? (opts.fontSizePx as number)
      : DEFAULT_FONT_PX;
  const minGapPx =
    Number.isFinite(opts.minGapPx) && (opts.minGapPx as number) >= 0
      ? (opts.minGapPx as number)
      : MIN_GAP_PX;
  const rotation = Number.isFinite(opts.rotationDeg)
    ? Math.abs(opts.rotationDeg as number)
    : 0;
  const fallbackChars =
    Number.isFinite(opts.avgLabelChars) && (opts.avgLabelChars as number) > 0
      ? (opts.avgLabelChars as number)
      : FALLBACK_LABEL_CHARS;
  const labelHeight = fontSizePx * LINE_HEIGHT_FACTOR;

  let footprintPx: number;
  if (rotation >= 1) {
    // Rotated labels: spacing is bounded by label HEIGHT projected onto the
    // axis, independent of text length. clamp sin away from 0 for tiny angles.
    const sin = Math.sin((Math.min(rotation, 90) * Math.PI) / 180);
    footprintPx = (labelHeight + minGapPx) / Math.max(sin, 0.2);
  } else {
    const chars = widestLabelChars(opts.labels, fallbackChars);
    const textWidth = Math.max(8, chars * fontSizePx * CHAR_WIDTH_FACTOR);
    footprintPx = textWidth + minGapPx;
  }

  if (!Number.isFinite(footprintPx) || footprintPx <= 0) {
    return DEFAULT_MAX_X_AXIS_LABELS;
  }
  const raw = Math.floor(axisWidthPx / footprintPx);

  // The real ceiling: never more labels than data points (or, lacking an
  // explicit count, than the provided labels). The ABS guard is only a
  // pathological-DOM backstop — data + density govern in every real case.
  const dataCap =
    Number.isFinite(opts.dataPointCount) && (opts.dataPointCount as number) > 0
      ? Math.floor(opts.dataPointCount as number)
      : opts.labels && opts.labels.length > 0
        ? opts.labels.length
        : Number.POSITIVE_INFINITY;
  const ceiling = Math.min(ABS_MAX_X_AXIS_LABELS, dataCap);
  return Math.max(MIN_X_AXIS_LABELS, Math.min(ceiling, raw));
}

/** A label-count budget plus whether the labels should be tilted to fit more. */
export interface XAxisTickPlan {
  /** Max number of tick labels to render (see `maxXAxisLabels`). */
  max: number;
  /** Degrees to rotate the labels (0 = horizontal; -45 = tilt-to-fit). */
  rotateDeg: number;
}

/**
 * THE single entry point every chart surface (recharts chat card + modals, visx
 * renderers) delegates to, so the same chart shows the same density everywhere.
 *
 * It decides BOTH how many labels fit AND whether to tilt them from one set of
 * area + data inputs — "rotate-to-fit": short/few labels stay horizontal (they
 * already fit many), long or numerous labels tilt -45° so the axis packs far
 * more than horizontal text would allow. The number of data points is never
 * reduced; only the labels are thinned/rotated as the width demands.
 */
export function xAxisTickBudget(opts: {
  axisWidthPx?: number;
  labels?: ReadonlyArray<unknown>;
  dataPointCount?: number;
  fontSizePx?: number;
  minGapPx?: number;
}): XAxisTickPlan {
  const widest = widestLabelChars(opts.labels, FALLBACK_LABEL_CHARS);
  const count = opts.dataPointCount ?? opts.labels?.length ?? 0;
  // Tilt when horizontal labels would crowd: long text OR many categories.
  const rotateDeg = widest > 6 || count > 12 ? -45 : 0;
  const max = maxXAxisLabels({
    axisWidthPx: opts.axisWidthPx,
    labels: opts.labels,
    dataPointCount: opts.dataPointCount,
    fontSizePx: opts.fontSizePx,
    minGapPx: opts.minGapPx,
    rotationDeg: rotateDeg,
  });
  return { max, rotateDeg };
}

export function pickEvenlySpacedTicks<T>(values: readonly T[], max: number = MAX_X_AXIS_LABELS): T[] {
  const n = values.length;
  if (n === 0) return [];
  if (n <= max) return [...values];
  if (max <= 1) return [values[0]];
  const out: T[] = [];
  const step = (n - 1) / (max - 1);
  const seen = new Set<number>();
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * step);
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(values[idx]);
    }
  }
  return out;
}

export function echartsLabelInterval(domainLength: number, max: number = MAX_X_AXIS_LABELS): number {
  if (domainLength <= max) return 0;
  return Math.ceil(domainLength / max) - 1;
}
