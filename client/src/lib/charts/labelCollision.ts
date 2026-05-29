/**
 * Wave W-GMK6 · placeLabelsNoOverlap
 *
 * Pure greedy label placement helper used by every visx mark renderer
 * (Bar, Line, Area, Point) so data labels appear ON by default but
 * silently drop when their bounding boxes would collide. Mirrors the
 * user requirement: "give data labels for all things unless they start
 * to overlap. if they overlap, then we can skip so as to avoid overlap
 * and maintain the good UI we have."
 *
 * No DOM, no canvas measurement — text width is approximated from
 * character count × font size × stretch factor. SVG `<text>` rendering
 * at the SF/Inter family at ~10–12 px averages ~0.55 of the font size
 * per character; we use 0.6 to bias toward conservative (over-) estimates
 * so labels err on the side of fewer rather than more.
 *
 * Single linear pass over sorted candidates. No spatial index needed at
 * typical chart densities (<200 candidates).
 */

export interface LabelCandidate {
  /** Anchor x (e.g. bar centre, point x). */
  cx: number;
  /** Anchor y (e.g. bar top, point y). */
  cy: number;
  /** The rendered text. */
  text: string;
  /**
   * Higher = placed first. When unspecified, candidates are placed in input
   * order. Callers often want highest-y or highest-priority points first so
   * the most-important labels are kept when the chart gets dense.
   */
  priority?: number;
}

export interface LabelPlacement extends LabelCandidate {
  /** Computed bounding-box x (top-left). */
  x: number;
  /** Computed bounding-box y (top-left). */
  y: number;
  /** Computed bounding-box width in pixels. */
  w: number;
  /** Computed bounding-box height in pixels. */
  h: number;
}

export interface PlaceLabelsOptions {
  /** Font size in px (default 10). */
  fontSize?: number;
  /** Padding around each label's bbox when checking collisions (default 2). */
  padding?: number;
  /** Optional chart inner bounds — labels outside are dropped. */
  bounds?: { x: number; y: number; w: number; h: number };
  /**
   * Anchor offset — how far above the (cx, cy) anchor to draw the label.
   * Default -2 means "2px above the anchor" (negative y = up in SVG).
   */
  anchorOffsetY?: number;
}

const CHAR_WIDTH_FACTOR = 0.6;
const LINE_HEIGHT_FACTOR = 1.2;

function estimateTextWidth(text: string, fontSize: number): number {
  return Math.max(8, text.length * fontSize * CHAR_WIDTH_FACTOR);
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  padding: number
): boolean {
  return (
    a.x - padding < b.x + b.w + padding &&
    a.x + a.w + padding > b.x - padding &&
    a.y - padding < b.y + b.h + padding &&
    a.y + a.h + padding > b.y - padding
  );
}

function rectInsideBounds(
  rect: { x: number; y: number; w: number; h: number },
  bounds: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    rect.x >= bounds.x &&
    rect.y >= bounds.y &&
    rect.x + rect.w <= bounds.x + bounds.w &&
    rect.y + rect.h <= bounds.y + bounds.h
  );
}

/**
 * Greedy collision-free placement. Sort candidates by priority desc, then
 * for each: compute bbox above the anchor (or use caller-provided bbox
 * via `boxOverride`), drop if it overlaps an already-placed bbox (with
 * `padding`), drop if outside `bounds`. Returns the surviving placements.
 *
 * Stable for ties — when priorities are equal, original array order is
 * preserved (Array#sort is stable in V8 ≥ 7.0 / Node 12+).
 */
export function placeLabelsNoOverlap(
  candidates: ReadonlyArray<LabelCandidate>,
  opts: PlaceLabelsOptions = {}
): LabelPlacement[] {
  const fontSize = opts.fontSize ?? 10;
  const padding = opts.padding ?? 2;
  const h = fontSize * LINE_HEIGHT_FACTOR;
  const anchorOffsetY = opts.anchorOffsetY ?? -2;

  const sorted = candidates
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const placed: LabelPlacement[] = [];
  for (const c of sorted) {
    if (!Number.isFinite(c.cx) || !Number.isFinite(c.cy)) continue;
    const w = estimateTextWidth(c.text, fontSize);
    const x = c.cx - w / 2;
    const y = c.cy + anchorOffsetY - h;
    const box = { x, y, w, h };
    if (opts.bounds && !rectInsideBounds(box, opts.bounds)) continue;
    const conflicts = placed.some((p) => rectsOverlap(box, p, padding));
    if (conflicts) continue;
    placed.push({ ...c, x, y, w, h });
  }
  return placed;
}

/**
 * Sibling helper for renderers (like BarRenderer) that compute their own
 * label positions (inside-bar, right-aligned, etc.) and just need the
 * collision filter. Takes pre-computed rects and returns the subset that
 * fits without overlap. Same greedy-by-priority algorithm.
 */
export interface RectCandidate<T = unknown> {
  x: number;
  y: number;
  w: number;
  h: number;
  priority?: number;
  /** Opaque payload returned with the surviving rects. */
  payload: T;
}

export function filterCollidingRects<T>(
  candidates: ReadonlyArray<RectCandidate<T>>,
  opts: { padding?: number; bounds?: { x: number; y: number; w: number; h: number } } = {}
): Array<RectCandidate<T>> {
  const padding = opts.padding ?? 2;
  const sorted = candidates
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const placed: Array<RectCandidate<T>> = [];
  for (const c of sorted) {
    if (
      !Number.isFinite(c.x) ||
      !Number.isFinite(c.y) ||
      !Number.isFinite(c.w) ||
      !Number.isFinite(c.h)
    ) continue;
    if (opts.bounds && !rectInsideBounds(c, opts.bounds)) continue;
    const conflicts = placed.some((p) => rectsOverlap(c, p, padding));
    if (conflicts) continue;
    placed.push(c);
  }
  return placed;
}
