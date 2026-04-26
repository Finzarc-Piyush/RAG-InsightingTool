/**
 * WD1 · Domain context pack types.
 *
 * Authored markdown files in `server/lib/domainContext/packs/` describe
 * Marico, FMCG industry context, competitors and seasonality. Each pack has
 * YAML frontmatter (`id` is the toggle marker addressed by the admin UI).
 *
 * Packs are compiled into `generatedPacks.ts` at build time (WD4) so esbuild
 * bundles them into `dist/index.js` — no runtime fs reads.
 */

export type PackCategory =
  | "products"
  | "industry"
  | "competition"
  | "seasonality"
  | "events"
  | "glossary";

export interface DomainPack {
  /** Toggle marker — stable, kebab-case. Referenced by the admin UI. */
  id: string;
  title: string;
  category: PackCategory;
  /** Lower runs first when concatenated. Used to keep the prompt prefix stable. */
  priority: number;
  /** Default state when no admin override exists. */
  enabledByDefault: boolean;
  /** Bumped manually on edits (frontmatter `version` field — free-form date). */
  version: string;
  /** The markdown body without frontmatter. */
  body: string;
  /** ≈ chars/4. Cached so the loader and admin UI both report consistent numbers. */
  approxTokens: number;
}

/** Slim shape returned by the admin list endpoint. */
export interface PackSummary {
  id: string;
  title: string;
  category: PackCategory;
  priority: number;
  version: string;
  approxTokens: number;
  enabled: boolean;
  defaultEnabled: boolean;
}
