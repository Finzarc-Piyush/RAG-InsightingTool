/**
 * Shared row/result types for the data-ops hot path (CQ-7).
 *
 * `DataRow` is the canonical "one record of a dataset" shape used throughout
 * `lib/dataOps/`: an object keyed by column name whose cell values are of
 * unknown type (numbers, strings, dates, null, …). It replaces the previous
 * pervasive `Record<string, any>` — same runtime shape, but `unknown` values
 * force call sites to narrow before use instead of silently propagating `any`.
 *
 * This is intentionally a thin alias rather than a branded type so it stays a
 * structural drop-in for the literal `Record<string, unknown>` used by the
 * Python-service request/response contracts and the MMM bridge.
 */
export type DataRow = Record<string, unknown>;

/**
 * Canonical return shape of `executeDataOperation` and the per-operation
 * handlers extracted from it (ARCH-2 / CQ-2 god-file decomposition). Kept here
 * — a leaf types module with no runtime deps — so handler modules in
 * `dataOps/handlers/*` and the orchestrator can both reference it via
 * `import type` without a circular import back into `dataOpsOrchestrator.ts`.
 *
 * `summary` mirrors `SummaryResponse['summary']` from `pythonService.ts`,
 * imported type-only so this leaf module keeps zero runtime dependencies (the
 * import is fully erased at compile time — no import cycle).
 */
import type { SummaryResponse } from "./pythonService.js";

export interface DataOpResult {
  answer: string;
  data?: DataRow[];
  preview?: DataRow[];
  summary?: SummaryResponse["summary"];
  saved?: boolean;
}
