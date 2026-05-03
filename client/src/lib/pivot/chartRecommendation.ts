/**
 * W1 · Re-export shim. The pivot chart recommender now lives at
 * `server/shared/pivot/chartRecommendation.ts` so the agent's server-side
 * `build_chart` path and this client-side pivot panel call the same
 * function. Edits to the recommender propagate to chat answer charts,
 * dashboard tiles, and the pivot section in lockstep.
 *
 * The cross-package import works via `vite.config.ts` `server.fs.allow`
 * widened to the repo root (same pattern as `client/src/shared/schema.ts`).
 */
export * from '../../../../server/shared/pivot/chartRecommendation';
