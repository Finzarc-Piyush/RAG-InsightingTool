/**
 * W5 · Schema source-of-truth.
 *
 * The schema is defined ONCE in `server/shared/schema.ts`. This file re-exports
 * from there so every client import (`@shared/schema`, `@/shared/schema`, etc.)
 * resolves to the same source — manual mirroring is no longer possible, drift
 * cannot happen.
 *
 * Vite's `server.fs.allow` is widened in `vite.config.ts` to permit the cross-
 * package import; tsconfig's `moduleResolution: bundler` handles the relative
 * path. Build remains a single-step `vite build` / `tsc --noEmit`.
 *
 * To revert (e.g. before a refactor that splits server/client schemas), restore
 * the previous content from git history at the commit before the W5 wave.
 */
export * from "../../../server/shared/schema";
