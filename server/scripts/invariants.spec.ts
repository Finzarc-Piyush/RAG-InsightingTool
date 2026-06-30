/**
 * Wave W1 · Single source of truth for the machine-checkable kernel of each
 * CLAUDE.md critical invariant.
 *
 * WHY THIS EXISTS — the cold-start firewall.
 * CLAUDE.md invariants are prose a fresh Claude session trusts implicitly. When
 * code moves and the prose doesn't, the session is not just slow — it is
 * confidently WRONG (e.g. invariant #4 told sessions to hand-edit a test
 * file-list that Wave R26 had already replaced with glob auto-discovery; the
 * lie survived 62 commits because nothing executed the claim). Each entry below
 * encodes the *checkable kernel* of an invariant as data; `check-invariants.ts`
 * executes every kernel against the live tree, so a frozen or contradicted
 * invariant becomes a red build instead of a silent misdirection.
 *
 * This file is the SoT the CLAUDE.md invariant list points at. Prose carries
 * judgment ("don't reintroduce a fallback"); this carries the assertion.
 *
 * Paths are relative to the repo root. Keep checks CONSERVATIVE: a false-fail is
 * loud and fixable; a false-pass re-opens the drift hole. Prefer structural
 * kinds (json_eq / symbol_exported / first_import / absent) over substring
 * matches on free-form behavioural prose, which break on harmless rewording.
 */

/** A single assertion against one file. ALL of an invariant's checks must pass. */
export type Check =
  /** File must CONTAIN the needle (string substring or RegExp match). */
  | { kind: "file_contains"; file: string; needle: string | RegExp; note?: string }
  /** File must NOT contain the needle — the contradiction guard. Catches a
   *  reintroduced footgun / a doc sentence that disagrees with code. */
  | { kind: "absent"; file: string; needle: string | RegExp; note?: string }
  /** JSON file: the value at a dotted path must deep-equal `equals`. */
  | { kind: "json_eq"; file: string; path: string; equals: unknown; note?: string }
  /** The first `import` statement in the file must reference `module`. */
  | { kind: "first_import"; file: string; module: string; note?: string }
  /** The file must export a top-level binding named `symbol`. */
  | { kind: "symbol_exported"; file: string; symbol: string; note?: string };

export interface Invariant {
  /** Matches the CLAUDE.md invariant number, e.g. "I4" ↔ invariant #4. */
  id: string;
  /** One-line human summary mirroring the CLAUDE.md prose. */
  title: string;
  checks: Check[];
}

export const INVARIANTS: ReadonlyArray<Invariant> = [
  {
    id: "I1",
    title: "AGENTIC_LOOP_ENABLED is mandatory — no legacy orchestrator fallback",
    checks: [
      {
        kind: "file_contains",
        file: "server/lib/dataAnalyzer.ts",
        needle: "the legacy orchestrator has been removed",
        note: "the throw that enforces the agentic-only path",
      },
      {
        kind: "absent",
        file: "docs/architecture/agent-runtime.md",
        needle: "legacy handler orchestrator takes",
        note: "the deleted-fallback contradiction (agent-runtime.md once said it 'takes over')",
      },
    ],
  },
  {
    id: "I3",
    title: "loadEnv MUST be the first import in server/index.ts",
    checks: [{ kind: "first_import", file: "server/index.ts", module: "./loadEnv.js" }],
  },
  {
    id: "I4",
    title: "Server `npm test` is glob auto-discovery (runTests.mjs), NOT a hand-maintained file list",
    checks: [
      {
        kind: "json_eq",
        file: "server/package.json",
        path: "scripts.test",
        equals: "node scripts/runTests.mjs",
      },
      {
        kind: "file_contains",
        file: "server/scripts/runTests.mjs",
        needle: "GLOB auto-discovery",
      },
      {
        kind: "absent",
        file: "CLAUDE.md",
        needle: "explicit file list",
        note: "guards the rewritten invariant #4 against regressing to the old footgun wording",
      },
      {
        kind: "absent",
        file: "docs/lessons.md",
        needle: "Glob-style discovery is NOT in play",
        note: "guards the rewritten L-005",
      },
    ],
  },
  {
    id: "I5",
    title: "Non-standard env file name: server/server.env (loaded by code, not tooling)",
    checks: [{ kind: "file_contains", file: "server/loadEnv.ts", needle: "server.env" }],
  },
  {
    id: "I7",
    title: "Verifier verdicts are constants from VERIFIER_VERDICT.* (never string literals)",
    checks: [
      {
        kind: "symbol_exported",
        file: "server/lib/agents/runtime/schemas.ts",
        symbol: "VERIFIER_VERDICT",
      },
    ],
  },
  {
    id: "I8",
    title: "Tool/skill duplicate name = fatal at boot (ToolAlreadyRegisteredError guard exists)",
    checks: [
      {
        kind: "symbol_exported",
        file: "server/lib/agents/runtime/toolRegistry.ts",
        symbol: "ToolAlreadyRegisteredError",
      },
    ],
  },
  {
    id: "I9",
    title: "mutateChatDocument is THE read-modify-write seam (lock + IfMatch _etag)",
    checks: [
      {
        kind: "symbol_exported",
        file: "server/models/chat.model.ts",
        symbol: "mutateChatDocument",
      },
      {
        kind: "file_contains",
        file: "server/models/chat.model.ts",
        needle: "withSessionWriteLock",
        note: "the per-session lock the RMW seam takes",
      },
      {
        kind: "file_contains",
        file: "server/models/chat.model.ts",
        needle: /ifMatch/i,
        note: "the Cosmos optimistic-concurrency precondition",
      },
    ],
  },
  {
    id: "I10",
    title: "Per-role model routing via OPENAI_MODEL_FOR_* override names (read llmCallPurpose.ts)",
    checks: [
      {
        kind: "file_contains",
        file: "server/lib/agents/runtime/llmCallPurpose.ts",
        needle: "OPENAI_MODEL_FOR",
      },
    ],
  },
  {
    id: "I11",
    title:
      "Temporal chart-axis grain is decided ONLY by temporalGrainAuthority.resolveTrendGrain — no chart builder rolls its own",
    checks: [
      {
        kind: "symbol_exported",
        file: "server/lib/temporalGrainAuthority.ts",
        symbol: "resolveTrendGrain",
        note: "the single grain authority all chart builders delegate to",
      },
      {
        kind: "symbol_exported",
        file: "server/lib/temporalGrainAuthority.ts",
        symbol: "DEFAULT_FACET_PREFERENCE",
        note: "the grain-preference array lives ONLY in the authority",
      },
      // Chart builders must call resolveTrendGrain, never the raw span picker or a
      // local preference array — that duplication was the 'fixed on one route only' bug.
      {
        kind: "absent",
        file: "server/lib/agents/runtime/visualPlanner.ts",
        needle: "pickTrendGrainForSpan",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/visualPlanner.ts",
        needle: "DEFAULT_FACET_PREFERENCE",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/dashboardFeatureSweep.ts",
        needle: "pickTrendGrainForSpan",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/dashboardFeatureSweep.ts",
        needle: "DEFAULT_FACET_PREFERENCE",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/chartFromTable.ts",
        needle: "pickTrendGrainForSpan",
      },
      {
        kind: "absent",
        file: "server/lib/periodColumnResolver.ts",
        needle: "recommendGrainFromSpan",
        note: "deleted — periodColumnResolver delegates grain to the authority",
      },
      {
        kind: "absent",
        file: "server/lib/periodColumnResolver.ts",
        needle: "DEFAULT_FACET_PREFERENCE",
      },
      // Sub-day (Wave H1–H5): hour/minute/hour-of-day buckets are computed ONLY by
      // the centralized inline expr (facetColumnInlineDuckDbExpr) + the authority.
      // No chart builder may hand-roll sub-day DuckDB SQL — that would re-open the
      // 'fixed on one route only' class of bug for intraday data.
      {
        kind: "absent",
        file: "server/lib/agents/runtime/visualPlanner.ts",
        needle: "date_trunc('hour'",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/dashboardFeatureSweep.ts",
        needle: "date_trunc('hour'",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/chartFromTable.ts",
        needle: "EXTRACT(hour",
      },
    ],
  },
  {
    id: "I12",
    title:
      "Question intent + depth budget are decided ONLY by queryIntentAuthority.classifyQueryIntent — the routing/suppression gates delegate, never re-regex",
    checks: [
      {
        kind: "symbol_exported",
        file: "server/lib/agents/runtime/queryIntentAuthority.ts",
        symbol: "classifyQueryIntent",
        note: "the single question-intent authority every gate delegates to",
      },
      {
        kind: "symbol_exported",
        file: "server/lib/agents/runtime/queryIntentAuthority.ts",
        symbol: "ANALYTICAL_CORE_RE",
        note: "the canonical analytical-intent vocabulary lives ONLY in the authority",
      },
      // The legacy classifiers must be THIN VIEWS over the authority — they call
      // classifyQueryIntent and no longer carry a private, drift-prone denylist.
      // (The divergent NON_FACTUAL_CUES vs ANALYTICAL_DENYLIST_REGEX copies were
      // the 'same question, different verdict' bug this authority retired.)
      {
        kind: "file_contains",
        file: "server/lib/agents/runtime/isDirectFactualQuestion.ts",
        needle: "classifyQueryIntent",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/isDirectFactualQuestion.ts",
        needle: "NON_FACTUAL_CUES",
        note: "deleted — the direct-factual denylist now lives in the authority",
      },
      {
        kind: "file_contains",
        file: "server/lib/agents/runtime/quickAnswerDetector.ts",
        needle: "classifyQueryIntent",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/quickAnswerDetector.ts",
        needle: "ANALYTICAL_DENYLIST_REGEX",
        note: "deleted — the lookup denylist now lives in the authority",
      },
      // The diagnostic-MODE vocabulary (analysisSpecRouter) also delegates: its
      // broad detector lives in the authority as DIAGNOSTIC_MODE_RE, distinct
      // from the narrow depth-budget DIAGNOSTIC_INTENT_RE but in the same home.
      {
        kind: "symbol_exported",
        file: "server/lib/agents/runtime/queryIntentAuthority.ts",
        symbol: "DIAGNOSTIC_MODE_RE",
        note: "the broad diagnostic-mode vocabulary lives in the authority",
      },
      {
        kind: "file_contains",
        file: "server/lib/analysisSpecRouter.ts",
        needle: "DIAGNOSTIC_MODE_RE",
      },
      {
        kind: "absent",
        file: "server/lib/analysisSpecRouter.ts",
        needle: "const DIAGNOSTIC_RE",
        note: "deleted — analysisSpecRouter delegates to the authority's DIAGNOSTIC_MODE_RE",
      },
    ],
  },
  {
    id: "I13",
    title:
      "Metric SEMANTICS — additivity AND structural-relatedness — are decided ONLY by financeMetricAuthority; chart/sweep/pivot/correlation/verifier delegate, no private rate regex or re-derived identities",
    checks: [
      // The authority's two coherent views are exported.
      {
        kind: "symbol_exported",
        file: "server/lib/financeMetricAuthority.ts",
        symbol: "isNonAdditiveMetric",
        note: "the thin-view additivity predicate every chart path imports",
      },
      {
        kind: "symbol_exported",
        file: "server/lib/financeMetricAuthority.ts",
        symbol: "aggregationPolicyFor",
        note: "the recompute→weighted_mean→mean→sum ladder",
      },
      {
        kind: "symbol_exported",
        file: "server/lib/financeMetricAuthority.ts",
        symbol: "FINANCE_TERMS",
      },
      {
        kind: "symbol_exported",
        file: "server/lib/financeMetricAuthority.ts",
        symbol: "areStructurallyRelated",
        note: "the tautology / accounting-identity detector the causation gates delegate to",
      },
      {
        kind: "symbol_exported",
        file: "server/lib/financeMetricAuthority.ts",
        symbol: "buildIdentityGraph",
      },
      {
        kind: "symbol_exported",
        file: "server/lib/financeMetricAuthority.ts",
        symbol: "FINANCE_IDENTITIES",
      },
      // The literal-"%" capability the three legacy regexes all lacked lives here.
      {
        kind: "file_contains",
        file: "server/lib/financeMetricAuthority.ts",
        needle: 'replace(/%/g, " pct ")',
        note: "the %→pct normaliser — the fix the \\b…\\b regexes could not express",
      },
      // The three drifting rate regexes are deleted; their owners delegate.
      {
        kind: "file_contains",
        file: "server/lib/chartSpecCompiler.ts",
        needle: "isNonAdditiveMetric",
      },
      {
        kind: "absent",
        file: "server/lib/chartSpecCompiler.ts",
        needle: "NON_ADDITIVE_METRIC_RX",
        note: "deleted — defaultBarLayout delegates to the authority",
      },
      {
        kind: "file_contains",
        file: "server/lib/agents/runtime/dashboardFeatureSweep.ts",
        needle: "isNonAdditiveMetric",
      },
      {
        kind: "absent",
        file: "server/lib/agents/runtime/dashboardFeatureSweep.ts",
        needle: "RATE_METRIC_RX",
        note: "deleted — the sweep delegates to the authority",
      },
      {
        kind: "file_contains",
        file: "server/lib/insightGenerator/pivotPatterns.ts",
        needle: "isNonAdditiveMetric",
        note: "the pivot rate-detector is augmented by the authority (name-based, not just [0,1])",
      },
      // Causation side — the identity graph is built once and every gate delegates.
      {
        kind: "file_contains",
        file: "server/lib/agents/runtime/context.ts",
        needle: "buildIdentityGraph",
        note: "ctx.identityGraph is built ONCE per turn here; gates read this instance",
      },
      {
        kind: "file_contains",
        file: "server/lib/correlationAnalyzer.ts",
        needle: "areStructurallyRelated",
        note: "definitional pairs are filtered before ranking/charting",
      },
      {
        kind: "file_contains",
        file: "server/lib/agents/runtime/verifierCausalCheck.ts",
        needle: "areStructurallyRelated",
        note: "the NO_STRUCTURAL_IDENTITY predicate delegates to the authority",
      },
      // Pack ↔ authority single-source-of-truth: the glossary states the rule, and
      // the generated bundle must carry it (so a pack edit can't ship un-regenerated).
      {
        kind: "file_contains",
        file: "server/lib/domainContext/packs/kpi-and-metric-glossary.md",
        needle: "Definitional relationships are not insights",
      },
      {
        kind: "file_contains",
        file: "server/lib/domainContext/generatedPacks.ts",
        needle: "Definitional relationships are not insights",
        note: "regenerate generatedPacks.ts after editing the glossary pack",
      },
    ],
  },
];
