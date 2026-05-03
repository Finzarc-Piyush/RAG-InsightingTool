/**
 * SVG fill-pattern palette for the `pattern` encoding channel.
 *
 * 8 patterns chosen so each is distinguishable in greyscale (so a
 * color-blind viewer sees them as distinct dimensions even when
 * `encoding.color` is also set). Each pattern is parameterized by
 * `color` so it inherits the qualitative palette.
 *
 * Usage: caller provides a `defs` builder that emits `<pattern>` SVG
 * elements with deterministic IDs (so two PremiumChart instances on
 * the same page don't collide). Bars / arcs / etc. then reference
 * the pattern via `fill="url(#<patternId>)"`.
 */

export const PATTERN_NAMES = [
  "solid",
  "horizontal",
  "vertical",
  "diagonal",
  "anti-diagonal",
  "cross",
  "dots",
  "checkers",
] as const;

export type PatternName = (typeof PATTERN_NAMES)[number];

export const PATTERN_PALETTE_SIZE = PATTERN_NAMES.length;

/** Pick a pattern name by category index, wrapping at the palette size. */
export function patternFromIndex(i: number): PatternName {
  const idx =
    ((i % PATTERN_PALETTE_SIZE) + PATTERN_PALETTE_SIZE) % PATTERN_PALETTE_SIZE;
  return PATTERN_NAMES[idx]!;
}

/** Build a stable unique id for a (renderer-instance, pattern, color)
 *  triple. The hash makes patterns stack with multiple charts on a page. */
export function patternId(
  prefix: string,
  pattern: PatternName,
  colorVar: string,
): string {
  // colorVar typically `hsl(var(--chart-N))`. Hash the var name so we
  // don't include the full string in DOM ids.
  const cv = colorVar.replace(/[^a-z0-9]/gi, "").slice(-12);
  return `pat-${prefix}-${pattern}-${cv}`;
}

export interface PatternDef {
  id: string;
  /** SVG markup for the <pattern>...</pattern> element body. */
  body: string;
  /** Tile size in pixels. */
  size: number;
}

/**
 * Build the inner SVG body for a given pattern + color. The caller
 * wraps in a <pattern id="..."> element with the right size.
 */
export function patternBody(pattern: PatternName, color: string): string {
  const stroke = `stroke="${color}" stroke-width="1.5"`;
  switch (pattern) {
    case "solid":
      return `<rect x="0" y="0" width="8" height="8" fill="${color}" />`;
    case "horizontal":
      return `<rect x="0" y="0" width="8" height="8" fill="${color}" fill-opacity="0.25" />
              <line x1="0" y1="2" x2="8" y2="2" ${stroke} />
              <line x1="0" y1="6" x2="8" y2="6" ${stroke} />`;
    case "vertical":
      return `<rect x="0" y="0" width="8" height="8" fill="${color}" fill-opacity="0.25" />
              <line x1="2" y1="0" x2="2" y2="8" ${stroke} />
              <line x1="6" y1="0" x2="6" y2="8" ${stroke} />`;
    case "diagonal":
      return `<rect x="0" y="0" width="8" height="8" fill="${color}" fill-opacity="0.25" />
              <line x1="0" y1="8" x2="8" y2="0" ${stroke} />
              <line x1="-2" y1="2" x2="2" y2="-2" ${stroke} />
              <line x1="6" y1="10" x2="10" y2="6" ${stroke} />`;
    case "anti-diagonal":
      return `<rect x="0" y="0" width="8" height="8" fill="${color}" fill-opacity="0.25" />
              <line x1="0" y1="0" x2="8" y2="8" ${stroke} />
              <line x1="-2" y1="6" x2="2" y2="10" ${stroke} />
              <line x1="6" y1="-2" x2="10" y2="2" ${stroke} />`;
    case "cross":
      return `<rect x="0" y="0" width="8" height="8" fill="${color}" fill-opacity="0.25" />
              <line x1="0" y1="8" x2="8" y2="0" ${stroke} />
              <line x1="0" y1="0" x2="8" y2="8" ${stroke} />`;
    case "dots":
      return `<rect x="0" y="0" width="8" height="8" fill="${color}" fill-opacity="0.18" />
              <circle cx="2" cy="2" r="1.2" fill="${color}" />
              <circle cx="6" cy="6" r="1.2" fill="${color}" />`;
    case "checkers":
      return `<rect x="0" y="0" width="4" height="4" fill="${color}" />
              <rect x="4" y="4" width="4" height="4" fill="${color}" />
              <rect x="0" y="4" width="4" height="4" fill="${color}" fill-opacity="0.2" />
              <rect x="4" y="0" width="4" height="4" fill="${color}" fill-opacity="0.2" />`;
  }
}

/**
 * Compute a paint reference for a (pattern, color) pair. Solid pattern
 * collapses to plain color (no <pattern> def needed). Other patterns
 * return both the URL and the <pattern> body so the caller can register
 * it inside <defs>.
 */
export function resolvePatternFill(
  prefix: string,
  pattern: PatternName,
  color: string,
): { fill: string; def?: PatternDef } {
  if (pattern === "solid") {
    return { fill: color };
  }
  const id = patternId(prefix, pattern, color);
  return {
    fill: `url(#${id})`,
    def: { id, body: patternBody(pattern, color), size: 8 },
  };
}
