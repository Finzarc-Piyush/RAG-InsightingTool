/**
 * Glyph generators for shape encoding. WC4.3.
 *
 * Each glyph is an SVG path string centered at the origin (0,0) with
 * a target *area* roughly equivalent to a circle of radius `r`. So a
 * mix of shapes in the same chart maintains visual weight balance.
 */

const SHAPES = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "cross",
  "plus",
  "star",
  "wedge",
] as const;

export type GlyphShape = (typeof SHAPES)[number];

const PALETTE_SIZE = SHAPES.length;

/** Pick a glyph shape by category index (cycles through the catalog). */
export function shapeFromIndex(i: number): GlyphShape {
  const idx = ((i % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return SHAPES[idx]!;
}

/** Build the SVG path for a glyph centered at (0,0) sized for radius r. */
export function glyphPath(shape: GlyphShape, r: number): string {
  switch (shape) {
    case "circle":
      // M cx cy m -r 0 a r r 0 1 0 2r 0 a r r 0 1 0 -2r 0
      return `M 0 0 m -${r} 0 a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
    case "square": {
      // Equal-area square — side ≈ r·√π
      const s = r * Math.sqrt(Math.PI);
      const h = s / 2;
      return `M ${-h} ${-h} L ${h} ${-h} L ${h} ${h} L ${-h} ${h} Z`;
    }
    case "triangle": {
      // Equilateral triangle, equal area
      const s = 2 * r * Math.sqrt(Math.PI / Math.sqrt(3));
      const h = (s * Math.sqrt(3)) / 2;
      const cy = h / 3;
      return `M 0 ${-2 * cy} L ${s / 2} ${cy} L ${-s / 2} ${cy} Z`;
    }
    case "diamond": {
      const s = r * Math.sqrt(2 * Math.PI);
      const h = s / 2;
      return `M 0 ${-h} L ${h} 0 L 0 ${h} L ${-h} 0 Z`;
    }
    case "cross": {
      // X-cross (multiplication-sign). Two crossing rectangles.
      const arm = r * 1.1;
      const w = r * 0.32;
      return [
        `M ${-arm} ${-arm} L ${-arm + w * 1.4} ${-arm}`,
        `L 0 ${-w} L ${arm - w * 1.4} ${-arm}`,
        `L ${arm} ${-arm} L ${arm} ${-arm + w * 1.4}`,
        `L ${w} 0 L ${arm} ${arm - w * 1.4}`,
        `L ${arm} ${arm} L ${arm - w * 1.4} ${arm}`,
        `L 0 ${w} L ${-arm + w * 1.4} ${arm}`,
        `L ${-arm} ${arm} L ${-arm} ${arm - w * 1.4}`,
        `L ${-w} 0 L ${-arm} ${-arm + w * 1.4} Z`,
      ].join(" ");
    }
    case "plus": {
      const arm = r * 1.05;
      const w = r * 0.36;
      return `M ${-w} ${-arm} L ${w} ${-arm} L ${w} ${-w} L ${arm} ${-w} L ${arm} ${w} L ${w} ${w} L ${w} ${arm} L ${-w} ${arm} L ${-w} ${w} L ${-arm} ${w} L ${-arm} ${-w} L ${-w} ${-w} Z`;
    }
    case "star": {
      const outer = r * 1.2;
      const inner = outer * 0.45;
      const points: string[] = [];
      for (let i = 0; i < 10; i++) {
        const angle = (Math.PI * 2 * i) / 10 - Math.PI / 2;
        const rr = i % 2 === 0 ? outer : inner;
        points.push(`${Math.cos(angle) * rr} ${Math.sin(angle) * rr}`);
      }
      return `M ${points[0]} ${points
        .slice(1)
        .map((p) => `L ${p}`)
        .join(" ")} Z`;
    }
    case "wedge": {
      // Half-disc pointed up.
      const s = r * Math.sqrt(2 * Math.PI);
      return `M ${-s / 2} 0 A ${s / 2} ${s / 2} 0 0 1 ${s / 2} 0 Z`;
    }
  }
}
