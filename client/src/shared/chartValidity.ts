/**
 * Client re-export of the shared chart-validity authority.
 *
 * The "is this chart fit to render?" rule — a `line`/`area`/`scatter` chart needs
 * ≥2 distinct x-axis points — is defined ONCE in `server/shared/chartValidity.ts`
 * and used identically on both tiers: the server drops degenerate single-point
 * trends before persisting; the client filters them out of the dashboard tile
 * list and the chat answer-card list so already-saved ones disappear on view.
 * This shim mirrors `client/src/shared/chartSort.ts` so client code imports via
 * the clean `@/shared/chartValidity` path. Vite's `server.fs.allow` (widened to
 * the repo root in vite.config.ts) permits the cross-package import.
 */
export * from "../../../server/shared/chartValidity";
