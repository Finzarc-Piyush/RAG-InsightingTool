/**
 * Client re-export of the shared per-chart insight lane parser.
 *
 * The `WHY:` / `DO:` wire format + `splitChartInsightLanes` / `joinChartInsightLanes`
 * are defined ONCE in `server/shared/chartInsightLanes.ts` so the generator that
 * EMITS the tagged `keyInsight` and the `ChartInsightBody` that PARSES it cannot
 * drift. This shim mirrors `client/src/shared/chartSort.ts` so client code
 * imports via the clean `@/shared/chartInsightLanes` path. Vite's `server.fs.allow`
 * (widened to the repo root in vite.config.ts) permits the cross-package import.
 */
export * from "../../../server/shared/chartInsightLanes";
