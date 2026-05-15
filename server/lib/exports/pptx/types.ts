/**
 * W-EXP-5 · Structural types for the pptxgenjs renderer.
 *
 * pptxgenjs ships ~3K lines of TS typings; importing them everywhere bloats
 * compile time and surfaces the dynamic-import shape mismatch documented at
 * [`pptxExport.service.ts:loadPptxGenJSCtor`](../../../services/dashboardExport/pptxExport.service.ts).
 * We use these narrow structural types so:
 *   - Layout files type-check against a stable surface independent of the
 *     pptxgenjs version.
 *   - Tests can mock the `Pres` object with a plain JS literal (no need to
 *     instantiate the real PPT engine just to validate slot wiring).
 *
 * The shapes match what pptxgenjs's runtime actually accepts; full options
 * are passed through as `Record<string, unknown>` because the API surface
 * is too large to enumerate and most options are documentation-only.
 */

export interface PptxRectShape {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PptxTextOptions extends Partial<PptxRectShape> {
  fontSize?: number;
  fontFace?: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  bullet?: boolean | { type?: "bullet" | "number"; code?: string };
  paraSpaceAfter?: number;
  // Allow further pass-through.
  [key: string]: unknown;
}

export interface PptxTextLine {
  text: string;
  options?: PptxTextOptions;
}

export interface PptxAddText {
  (
    text: string | PptxTextLine[],
    options: PptxTextOptions
  ): unknown;
}

export interface PptxSlide {
  background: { color: string };
  addText: PptxAddText;
  addShape: (
    shape: string,
    options: Partial<PptxRectShape> & { fill?: { color: string }; line?: { color: string; width?: number } } & Record<string, unknown>
  ) => unknown;
  addImage: (
    options: Partial<PptxRectShape> & { data?: string; path?: string; sizing?: unknown } & Record<string, unknown>
  ) => unknown;
  addChart: (
    chartType: unknown,
    data: unknown,
    options: Partial<PptxRectShape> & Record<string, unknown>
  ) => unknown;
  addTable: (rows: unknown[], options: Record<string, unknown>) => unknown;
  addNotes?: (notes: string) => unknown;
}

export interface PptxPres {
  author: string;
  title: string;
  layout: string;
  defineSlideMaster?: (opts: Record<string, unknown>) => unknown;
  addSlide: (opts?: { masterName?: string }) => PptxSlide;
  write: (opts: { outputType: string }) => Promise<unknown>;
}

/**
 * The pptxgenjs ChartType enum — re-declared as a plain object so layouts
 * can reference it without importing the full typings. Matches the runtime
 * string-enum values pptxgenjs's `addChart` accepts.
 */
export const PPTX_CHART_TYPE = {
  bar: "bar",
  line: "line",
  area: "area",
  pie: "pie",
  doughnut: "doughnut",
  scatter: "scatter",
  bubble: "bubble",
  radar: "radar",
} as const;
