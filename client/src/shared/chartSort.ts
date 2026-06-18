/**
 * Client re-export of the shared chart-sort authority.
 *
 * The ordering logic (comparators, `applyChartSort`, `resolveSort`) is defined
 * ONCE in `server/shared/chartSort.ts` and used identically on both tiers. This
 * shim mirrors `client/src/shared/schema.ts` so client code imports the helpers
 * via the clean `@/shared/chartSort` path. Vite's `server.fs.allow` (widened to
 * the repo root in vite.config.ts) permits the cross-package import.
 */
export * from "../../../server/shared/chartSort";
