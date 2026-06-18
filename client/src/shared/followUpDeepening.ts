/**
 * Re-export of the shared follow-up-deepening authority. Mirrors
 * `dashboardLayout.ts` / `schema.ts`: the logic is defined ONCE in
 * `server/shared/followUpDeepening.ts` and re-exported here so client imports
 * (`@/shared/followUpDeepening`) resolve to the same source the server uses —
 * the "is this follow-up already answered by a chart?" decision can never drift
 * between server generation and dashboard rendering.
 */
export * from "../../../server/shared/followUpDeepening";
