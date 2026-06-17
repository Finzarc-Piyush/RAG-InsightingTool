/**
 * Re-export of the shared dashboard-layout authority. Mirrors `schema.ts`: the
 * logic is defined ONCE in `server/shared/dashboardLayout.ts` and re-exported
 * here so client imports (`@/shared/dashboardLayout`) resolve to the same source
 * the server uses — the chart-count + box-span decision can never drift between
 * the inline chat answer and the saved /dashboard page.
 */
export * from "../../../server/shared/dashboardLayout";
