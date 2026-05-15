/**
 * W-EXP-7 · Legacy `buildDashboardPdf` / `buildDashboardPptx` shims.
 *
 * The legacy `POST /api/dashboards/:id/export` endpoint (the only PDF path
 * the client UI actually triggers — see `client/src/lib/api/dashboards.ts`)
 * routed through these two functions. They produced text-only artefacts
 * with chart titles as bullet lines — the "shitty PDF/PPT" failure mode
 * this rewrite exists to fix.
 *
 * After W-EXP-7 both functions delegate to the new agentic deck pipeline:
 *   - PPTX → `buildDashboardDeckPptx` (pptxgenjs native shapes / charts /
 *     tables; SVG fallback for chart types pptxgenjs can't render natively)
 *   - PDF → `buildDashboardDeckPdf` (Puppeteer + @sparticuz/chromium-min
 *     over a print-styled React route, with @react-pdf/renderer fallback;
 *     wires up in W-EXP-9/11)
 *
 * Kept as a thin shim file so the route + controller signatures stay
 * call-compatible across the rewrite. Once both render paths land, the
 * shim itself can be deleted (W-EXP-12 cleanup).
 */
import {
  buildDashboardDeckPptx,
  buildDashboardDeckPdf,
} from "../lib/exports/buildDashboardDeck.js";
import type { Dashboard } from "../shared/schema.js";

export async function buildDashboardPdf(dashboard: Dashboard): Promise<Buffer> {
  return buildDashboardDeckPdf(dashboard);
}

export async function buildDashboardPptx(dashboard: Dashboard): Promise<Buffer> {
  return buildDashboardDeckPptx(dashboard);
}
