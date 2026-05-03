/**
 * PV2 · Re-export shim. The pivot chart-type validity helper lives at
 * `server/shared/pivot/chartTypeValidity.ts` so the agent's server-side
 * `build_chart` path and this client-side pivot panel call the same
 * function.
 *
 * Mirrors the pattern used by `chartRecommendation.ts` — the cross-package
 * import works via `vite.config.ts` `server.fs.allow` widened to the repo
 * root.
 */
export * from '../../../../server/shared/pivot/chartTypeValidity';
