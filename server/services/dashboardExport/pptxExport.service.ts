/**
 * W-EXP-7 · `buildDashboardPptxBuffer` — now backed by the agentic deck-builder.
 *
 * Replaces the W7.3 text-only implementation. Delegates entirely to
 * [`buildDashboardDeckPptx`](../../lib/exports/buildDashboardDeck.ts) which
 * runs the full pipeline:
 *   1. `runDeckPlanner` — Claude Opus 4.7 composes a `SlideDeckPlan`
 *   2. `verifyDeckPlan` — deterministic gate; one repair round on fail
 *   3. `renderDeckPlanToPptxBuffer` — pptxgenjs native shapes / charts /
 *      tables; SVG fallback only for chart types pptxgenjs can't render
 *      natively (heatmap)
 *
 * Falls back to a deterministic minimal deck if the planner can't produce
 * a valid plan even after one repair round. The user always gets a
 * download.
 *
 * Kept as a thin re-export so the existing controller wiring at
 * `dashboardExportController.exportDashboardPptxController` stays
 * call-compatible — no controller change required.
 */
import { buildDashboardDeckPptx } from "../../lib/exports/buildDashboardDeck.js";
import type { Dashboard } from "../../shared/schema.js";

export async function buildDashboardPptxBuffer(dashboard: Dashboard): Promise<Buffer> {
  return buildDashboardDeckPptx(dashboard);
}
