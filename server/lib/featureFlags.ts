/**
 * ============================================================================
 * featureFlags.ts — the single TYPED registry of the server's feature flags
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Enumerates, in one place, every boolean-ish environment feature flag the
 *   server reads (the `*_ENABLED`, `DISABLE_*`, `ALLOW_*` family). For each it
 *   records its DEFAULT (the polarity already baked into the ad-hoc read sites),
 *   a one-line purpose, and a lifecycle tag. A typed accessor `isFlagOn(name)`
 *   reads `process.env[name]` case-insensitively against that registered default,
 *   and `listFlags()` exposes the table to docs/tooling.
 *
 * WHY IT MATTERS
 *   The ~28 flags were each parsed inline with subtly different truthiness
 *   (`=== "true"` vs `!== "false"` vs a local `truthy`/`num`), so the same flag
 *   value could behave differently on different read paths (the
 *   `BUSINESS_ACTIONS_ENABLED` live-vs-replay fork was exactly this). A single
 *   registry pins the default + the parse so a new reader can't reintroduce a
 *   fork, and gives docs/tooling one authoritative list.
 *
 * SCOPE (deliberately narrow)
 *   This file is the registry + accessor only. It does NOT migrate the existing
 *   ad-hoc `process.env.X === "true"` read sites — that is a separate finding
 *   (CFG-2). `envFlags.ts` sources its known-flag defaults from here so the two
 *   never disagree, but every existing exported `envFlags` function keeps its
 *   name and behavior.
 *
 * HOW IT CONNECTS
 *   Depends only on `envFlags.ts` for the case-insensitive truthiness primitives
 *   (`envFlagOn` / `envFlagEnabledByDefault`). No other imports.
 */

import { envFlagOn, envFlagEnabledByDefault } from "./envFlags.js";

/** Lifecycle of a flag — informational, for docs/tooling triage. */
export type FlagLifecycle = "stable" | "experimental" | "deprecated";

/** One registry row: its default polarity, a human purpose, and a lifecycle. */
export interface FlagSpec {
  /** Value when the env var is unset (the polarity baked into existing reads). */
  default: boolean;
  /** One-line description of what turning this flag on/off does. */
  purpose: string;
  /** Maturity tag for triage; not enforced anywhere. */
  lifecycle: FlagLifecycle;
}

/**
 * THE registry. Keys are the exact `process.env` names. `default` mirrors the
 * polarity already implemented at each read site (default-OFF flags are read as
 * `=== "true"`/`=== "1"`; default-ON flags only disable on `=== "false"`).
 *
 * Note on `DISABLE_*`: the registered `default`/`isFlagOn` reflect the flag's
 * OWN truthiness (is the value set to a truthy string?), NOT the behaviour it
 * gates. e.g. `DISABLE_TEMPORAL_FACETS` defaults to OFF, meaning temporal facets
 * are ON by default.
 */
export const FEATURE_FLAGS = {
  // ── Agent runtime ────────────────────────────────────────────────────────
  AGENTIC_LOOP_ENABLED: {
    default: false,
    purpose:
      "Mandatory agentic plan/act loop. `dataAnalyzer.answerQuestion` throws if off (invariant #1).",
    lifecycle: "stable",
  },
  AGENTIC_ALLOW_NO_RAG: {
    default: false,
    purpose:
      "Test-only escape hatch: run the agentic loop without RAG configured.",
    lifecycle: "experimental",
  },
  AGENT_DECOMPOSITION_ENABLED: {
    default: false,
    purpose: "Decompose multi-part questions into sub-questions before planning.",
    lifecycle: "experimental",
  },
  DIRECT_ANSWER_ENABLED: {
    default: false,
    purpose: "Allow a direct-answer fast path for simple factual questions.",
    lifecycle: "experimental",
  },
  QUICK_LOOKUP_ENABLED: {
    default: true,
    purpose: "Short-circuit plain lookups without the full plan/act loop.",
    lifecycle: "stable",
  },
  DEEP_INVESTIGATION_ENABLED: {
    default: false,
    purpose: "Deep multi-step investigation flow (gated; single-flow policy).",
    lifecycle: "experimental",
  },
  DEEP_ANALYSIS_SKILLS_ENABLED: {
    default: false,
    purpose: "Enable the deep-analysis skill set inside the agent loop.",
    lifecycle: "experimental",
  },
  SPAWNED_FOLLOWUP_ENABLED: {
    default: false,
    purpose: "Auto-investigate 'investigating further' spawned follow-up chips.",
    lifecycle: "experimental",
  },
  EXHAUSTIVE_BREADTH_ENABLED: {
    default: false,
    purpose: "Widen the dashboard feature sweep to exhaustive breadth.",
    lifecycle: "experimental",
  },
  RICH_STEP_INSIGHTS_ENABLED: {
    default: false,
    purpose: "Emit richer per-step insight narration during the loop.",
    lifecycle: "experimental",
  },
  STREAMING_NARRATOR_ENABLED: {
    default: false,
    purpose: "Stream the narrator output incrementally over SSE.",
    lifecycle: "experimental",
  },
  BUSINESS_ACTIONS_ENABLED: {
    default: true,
    purpose:
      "Emit business-action recommendations. Single accessor avoids the live-vs-replay case fork.",
    lifecycle: "stable",
  },
  CONCURRENT_TURN_GUARD_ENABLED: {
    default: false,
    purpose:
      "DATA-5: reject (HTTP 409) a second turn that starts while a live turn already holds the durable per-session turn lease. Default OFF — the lease is still recorded for observability but never rejects.",
    lifecycle: "experimental",
  },

  // ── Analytical capabilities ───────────────────────────────────────────────
  ANOMALY_DETECTION_ENABLED: {
    default: false,
    purpose: "Run anomaly-detection passes over series data.",
    lifecycle: "experimental",
  },
  FORECAST_ENABLED: {
    default: false,
    purpose: "Enable forecasting tools/skills.",
    lifecycle: "experimental",
  },
  SIGNIFICANCE_TESTS_ENABLED: {
    default: false,
    purpose: "Run statistical significance tests on comparisons.",
    lifecycle: "experimental",
  },
  DIAGNOSTIC_COMPOSITE_TOOL_ENABLED: {
    default: false,
    purpose: "Enable the composite diagnostic tool in the registry.",
    lifecycle: "experimental",
  },
  DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED: {
    default: false,
    purpose: "Merge parsed-query filters into intermediate diagnostic pivots.",
    lifecycle: "experimental",
  },
  LARGE_FILE_COERCION_ENABLED: {
    default: false,
    purpose: "Coerce/repair oversized uploads instead of rejecting them.",
    lifecycle: "experimental",
  },

  // ── Charts / dashboards ────────────────────────────────────────────────────
  DASHBOARD_AUTOGEN_ENABLED: {
    default: false,
    purpose: "Auto-generate a dashboard after a qualifying answer.",
    lifecycle: "experimental",
  },
  AUTO_ATTACH_LAYERS_ENABLED: {
    default: true,
    purpose: "Auto-attach reference/comparison layers to charts.",
    lifecycle: "stable",
  },
  DISABLE_TEMPORAL_FACETS: {
    default: false,
    purpose:
      "Kill switch: when set, disables temporal facet axes (facets are on by default).",
    lifecycle: "stable",
  },

  // ── RAG / retrieval / caching ─────────────────────────────────────────────
  RAG_ENABLED: {
    default: false,
    purpose: "Enable Azure AI Search retrieval + indexing (needs credentials).",
    lifecycle: "stable",
  },
  PAST_ANALYSES_INDEX_ENABLED: {
    default: true,
    purpose: "Write answered analyses to the past-analyses AI Search index.",
    lifecycle: "stable",
  },
  QUESTION_CACHE_EXACT_ENABLED: {
    default: false,
    purpose: "Serve exact-match cached answers for repeat questions.",
    lifecycle: "experimental",
  },
  QUESTION_CACHE_SEMANTIC_ENABLED: {
    default: false,
    purpose: "Serve semantically-similar cached answers for repeat questions.",
    lifecycle: "experimental",
  },
  WEB_SEARCH_ENABLED: {
    default: false,
    purpose: "Enable the web-search tool for external context.",
    lifecycle: "experimental",
  },

  // ── Telemetry ──────────────────────────────────────────────────────────────
  LLM_USAGE_TELEMETRY_ENABLED: {
    default: true,
    purpose: "Write LLM token/usage telemetry to Cosmos via the default sink.",
    lifecycle: "stable",
  },
  USAGE_EVENTS_ENABLED: {
    default: true,
    purpose: "Record product usage events to Cosmos (off only on `=false`).",
    lifecycle: "stable",
  },

  // ── Upload / enrichment ────────────────────────────────────────────────────
  DISABLE_UPLOAD_INITIAL_ANALYSIS: {
    default: false,
    purpose:
      "Kill switch: skip the automatic initial analysis after an upload (analysis runs by default).",
    lifecycle: "stable",
  },
  WIDE_FORMAT_AUTO_MELT_ENABLED: {
    default: true,
    purpose:
      "Auto-melt detected wide-format uploads to long form (off only on `=false`/`=0`).",
    lifecycle: "stable",
  },
  PAST_ANALYSIS_WRITER_ENABLED: {
    default: true,
    purpose:
      "Persist answered analyses to the past-analyses store (off only on `=false`).",
    lifecycle: "stable",
  },
  AUTO_TITLE_ANALYSIS_ENABLED: {
    default: true,
    purpose:
      "Auto-rename a new analysis from its first Q&A (LLM title, deterministic fallback). Off only on `=false`; user renames always win.",
    lifecycle: "stable",
  },

  // ── HTTP / auth (middleware) ───────────────────────────────────────────────
  CORS_ALLOW_NO_ORIGIN: {
    default: false,
    purpose:
      "In production, accept requests with no Origin header (off by default).",
    lifecycle: "stable",
  },
  ALLOW_JWT_QUERY: {
    default: false,
    purpose:
      "Accept the access token in the query string (leaks into logs; dev-only).",
    lifecycle: "deprecated",
  },
  DISABLE_AUTH: {
    default: false,
    purpose:
      "Local-dev auth bypass (only honoured in development/test, never on Vercel).",
    lifecycle: "stable",
  },
} as const satisfies Record<string, FlagSpec>;

/** The set of registered flag names, as a literal union for typed callers. */
export type FlagName = keyof typeof FEATURE_FLAGS;

/**
 * Read a registered flag from `process.env`, case-insensitively, honouring its
 * registered default polarity:
 *   - default-OFF flags are ON only for `1/true/yes/on` (via `envFlagOn`);
 *   - default-ON flags are OFF only for `0/false/no/off` (via
 *     `envFlagEnabledByDefault`).
 * Unset env always returns the registered default.
 */
export function isFlagOn(name: FlagName): boolean {
  const spec = FEATURE_FLAGS[name];
  const raw = process.env[name];
  return spec.default
    ? envFlagEnabledByDefault(raw)
    : envFlagOn(raw);
}

/** A single flattened registry row, for docs/tooling. */
export interface FlagListing extends FlagSpec {
  name: FlagName;
}

/**
 * Return the registry as an array of `{ name, default, purpose, lifecycle }`
 * rows. Sorted by name for stable doc/tooling output.
 */
export function listFlags(): FlagListing[] {
  return (Object.keys(FEATURE_FLAGS) as FlagName[])
    .sort()
    .map((name) => ({ name, ...FEATURE_FLAGS[name] }));
}

/** Lookup a flag's default polarity by name (registry-typed). */
export function flagDefault(name: FlagName): boolean {
  return FEATURE_FLAGS[name].default;
}
