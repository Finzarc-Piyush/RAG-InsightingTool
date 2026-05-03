/**
 * Wave W7 · buildSynthesisContext
 *
 * Pure-ish helper that bundles the contextual signals the project already
 * computes (domain packs, RAG hits, data understanding, user identity) into
 * four labelled markdown blocks. The narrator and synthesizer both consume
 * the same bundle so prompt-cache prefixes stay byte-stable across calls
 * within a turn.
 *
 * Why this lives outside the writers: pre-W7, the narrator and synthesizer
 * each had to mine signals out of the raw `sessionAnalysisContext` JSON blob
 * and never saw the domain packs or upfront RAG hits at all. Centralising
 * the bundle here means new context (e.g. web-search hits in a later wave)
 * gets wired into both writers in one place.
 */
import type { AgentExecutionContext } from "./types.js";
import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";

// WTL2 · 6_000 → 9_000. Marico packs grow over time and 6k started
// truncating mid-paragraph on the larger ones.
const DOMAIN_BLOCK_CHAR_CAP = 9_000;
// WTL2 · W16 bumped 4_000 → 6_000 to fit the web-search sub-section;
// 6_000 → 9_000 because the three sub-sections (vector / keyword / web)
// were competing for the same budget and the synthesiser was missing
// late hits. Each web hit ~1.5k × up to 5 = 7.5k worst case.
const RAG_BLOCK_CHAR_CAP = 9_000;
const COLUMN_ROLES_MAX = 20;
const SUGGESTED_FOLLOWUPS_MAX = 4;
// WTL2 · 2_000 → 4_000. User permanent context directly reflects how much
// intent / preference the LLM sees; 2k clipped multi-paragraph user notes.
const PERMANENT_NOTES_CAP = 4_000;

export interface SynthesisContextBundle {
  /** FMCG/Marico authored packs (already loaded into ctx.domainContext). */
  domainBlock: string;
  /** Pre-extracted dataset summary: grain, top column roles, caveats, applied filters. */
  dataUnderstandingBlock: string;
  /** Upfront RAG hits + blackboard.domainContext entries (rag_round1 / rag_round2). */
  ragBlock: string;
  /** Authenticated user identity, permanent notes, suggested follow-ups. */
  userBlock: string;
}

export interface BuildSynthesisContextInput {
  /** Optional formatted RAG block from the upfront retrieval (P-A1). */
  upfrontRagHitsBlock?: string;
  /** Optional analytical blackboard — `domainContext` entries surface here as RAG round-2 hits. */
  blackboard?: AnalyticalBlackboard;
  /**
   * G4-P5 · structured tool I/O captured by the agent loop (Wave B3). Lets
   * the narrator's data-understanding block list each step's tool, args
   * (filter / groupBy / etc.), output row count, and aggregation flag — so
   * the narrator can tell "this step queried all four regions" from "this
   * step filtered to Central only" instead of guessing from text observations.
   */
  structuredObservations?: ReadonlyArray<{
    stepId: string;
    tool: string;
    args: Record<string, unknown>;
    metrics: {
      inputRowCount?: number;
      outputRowCount?: number;
      appliedAggregation?: boolean;
      durationMs?: number;
    };
  }>;
}

/**
 * Compose the four bundle blocks. Each block is independently optional and
 * returns "" when no signal is present, so the caller can join with section
 * headers and let empty sections vanish.
 */
export function buildSynthesisContext(
  ctx: AgentExecutionContext,
  input: BuildSynthesisContextInput = {}
): SynthesisContextBundle {
  return {
    domainBlock: buildDomainBlock(ctx),
    dataUnderstandingBlock: buildDataUnderstandingBlock(ctx, input),
    ragBlock: buildRagBlock(ctx, input),
    userBlock: buildUserBlock(ctx),
  };
}

function buildDomainBlock(ctx: AgentExecutionContext): string {
  const raw = ctx.domainContext?.trim();
  if (!raw) return "";
  return raw.slice(0, DOMAIN_BLOCK_CHAR_CAP);
}

function buildDataUnderstandingBlock(
  ctx: AgentExecutionContext,
  input: BuildSynthesisContextInput = {}
): string {
  const sac = ctx.sessionAnalysisContext;
  const lines: string[] = [];

  if (sac?.dataset?.shortDescription) {
    lines.push(`Dataset: ${sac.dataset.shortDescription.trim()}`);
  }

  const summary = ctx.summary;
  if (summary && (summary.rowCount || summary.columnCount)) {
    const r = typeof summary.rowCount === "number" ? summary.rowCount : "?";
    const c = typeof summary.columnCount === "number" ? summary.columnCount : "?";
    lines.push(`Shape: ${r} rows × ${c} columns`);
  }

  // WPF1 · When the dataset was melted from wide format at upload, surface the
  // long-form schema semantics so the narrator phrases magnitudes correctly
  // (e.g. cites the metric name not raw "Value", uses Period labels for
  // human-readable periods, doesn't fabricate the original wide column names).
  const wf = summary?.wideFormatTransform;
  if (wf?.detected) {
    const isCompound = wf.shape === "compound" && !!wf.metricColumn;
    const valueCol = summary.columns.find((c) => c.name === wf.valueColumn);
    const cur = valueCol?.currency
      ? ` in ${valueCol.currency.isoCode} (${valueCol.currency.symbol})`
      : "";
    lines.push(
      `Wide-format melt: this dataset was reshaped from wide → long at upload. ` +
        `Period column "${wf.periodColumn}" holds raw labels (display); ` +
        `"${wf.periodIsoColumn}" holds canonical sortable ISO values. ` +
        `"${wf.valueColumn}" is numeric${cur}. ` +
        (isCompound
          ? `Shape is COMPOUND — "${wf.valueColumn}" mixes multiple metrics, distinguished by "${wf.metricColumn}". ` +
            `When citing magnitudes, name the metric (e.g. "value sales", "volume") not the raw "${wf.valueColumn}" column.`
          : `Shape is pure-period — every row is one ${wf.valueColumn} measurement per id × period.`)
    );
  }

  const grain = sac?.dataset?.grainGuess?.trim();
  if (grain) lines.push(`Grain: ${grain}`);

  const roles = sac?.dataset?.columnRoles ?? [];
  if (roles.length > 0) {
    const sliced = roles.slice(0, COLUMN_ROLES_MAX);
    lines.push("Key columns:");
    for (const r of sliced) {
      const note = r.notes?.trim() ? ` — ${r.notes.trim().slice(0, 200)}` : "";
      lines.push(`  • ${r.name} (${r.role})${note}`);
    }
    if (roles.length > COLUMN_ROLES_MAX) {
      lines.push(`  …and ${roles.length - COLUMN_ROLES_MAX} more.`);
    }
  }

  const caveats = (sac?.dataset?.caveats ?? []).filter(Boolean);
  if (caveats.length > 0) {
    lines.push("Data caveats:");
    for (const c of caveats.slice(0, 6)) lines.push(`  • ${c}`);
  }

  const filters = ctx.inferredFilters ?? [];
  if (filters.length > 0) {
    const formatted = filters
      .slice(0, 8)
      .map((f) => `${f.column} ${f.op} [${f.values.slice(0, 6).join(", ")}]`);
    lines.push(`Applied filters this turn: ${formatted.join("; ")}`);
  }

  const facts = (sac?.sessionKnowledge?.facts ?? []).filter(
    (f) => f.confidence !== "low"
  );
  if (facts.length > 0) {
    lines.push("Established facts (from prior turns):");
    for (const f of facts.slice(0, 6)) {
      lines.push(`  • [${f.confidence}] ${f.statement}`);
    }
  }

  // W-PivotState · what view the user is currently looking at on the most
  // recent assistant message. Lets the narrator phrase the answer relative to
  // the active baseline ("compared to the bar chart you have open …").
  const pv = ctx.lastAssistantPivotState;
  if (pv) {
    const cfg = pv.config;
    const segs: string[] = [];
    if (cfg.rows.length) segs.push(`rows=${cfg.rows.join("|")}`);
    if (cfg.values.length)
      segs.push(`values=${cfg.values.map((v) => `${v.field}(${v.agg})`).join("|")}`);
    if (cfg.filters.length) segs.push(`filters=${cfg.filters.join("|")}`);
    if (pv.chart) segs.push(`chart=${pv.chart.type}`);
    if (pv.analysisView) segs.push(`view=${pv.analysisView}`);
    if (segs.length > 0) {
      lines.push(`Current pivot view: ${segs.join(" · ")}`);
    }
  }

  // G4-P5 · per-step tool scope so the narrator can distinguish "this step
  // queried the whole dataset" from "this step filtered to a subset". Without
  // this surface, the narrator concludes "data is incomplete" when looking
  // only at a filtered tool's output text. Each line lists tool name +
  // dimensionFilters / groupBy / outputRowCount.
  const obs = input.structuredObservations ?? [];
  if (obs.length > 0) {
    const stepLines: string[] = [];
    for (const o of obs.slice(-12)) {
      // last 12 to keep the prompt bounded
      const scope = formatToolScope(o.tool, o.args);
      const rowCount =
        o.metrics.outputRowCount !== undefined
          ? `${o.metrics.outputRowCount} rows`
          : "?";
      const aggMark = o.metrics.appliedAggregation ? " (aggregated)" : "";
      stepLines.push(
        `  • ${o.stepId} ${o.tool}${scope ? ` — ${scope}` : ""} → ${rowCount}${aggMark}`
      );
    }
    lines.push(
      "Tool calls run this turn (use these to judge whether each step covered the whole dataset or a filtered subset — do not infer 'data is incomplete' from a single filtered step's output):"
    );
    lines.push(...stepLines);
  }

  return lines.join("\n").trim();
}

/**
 * G4-P5 · render the meaningful scope-defining args of a tool call as a
 * compact line for the narrator. Surfaces dimensionFilters (so the narrator
 * sees "filtered to Central"), groupBy, plan-level dimensionFilters, etc.
 *
 * Best-effort — when args don't fit a known shape, returns "" and the
 * narrator just sees the row count.
 */
function formatToolScope(tool: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  // Common: dimensionFilters at top level (run_correlation, breakdown_ranking, etc.)
  const top = args as {
    dimensionFilters?: unknown;
    groupBy?: unknown;
    metrics?: unknown;
    plan?: unknown;
    question_override?: unknown;
  };
  const filters = top.dimensionFilters;
  if (Array.isArray(filters) && filters.length > 0) {
    const cells: string[] = [];
    for (const f of filters.slice(0, 4)) {
      const fo = f as { column?: string; values?: unknown[]; op?: string };
      if (fo.column && Array.isArray(fo.values)) {
        cells.push(
          `${fo.column} ${fo.op ?? "in"} [${fo.values.slice(0, 4).join(", ")}]`
        );
      }
    }
    if (cells.length > 0) parts.push(`filters: ${cells.join("; ")}`);
  }
  const gb = top.groupBy;
  if (Array.isArray(gb) && gb.length > 0) {
    parts.push(`groupBy: ${gb.slice(0, 4).join(", ")}`);
  }
  // execute_query_plan args have a `plan` JSON with its own groupBy + dimensionFilters
  if (top.plan && typeof top.plan === "object") {
    const plan = top.plan as {
      groupBy?: unknown;
      dimensionFilters?: unknown;
    };
    const planGb = plan.groupBy;
    if (Array.isArray(planGb) && planGb.length > 0) {
      parts.push(`groupBy: ${planGb.slice(0, 4).join(", ")}`);
    }
    const planFilters = plan.dimensionFilters;
    if (Array.isArray(planFilters) && planFilters.length > 0) {
      const cells: string[] = [];
      for (const f of planFilters.slice(0, 4)) {
        const fo = f as { column?: string; values?: unknown[]; op?: string };
        if (fo.column && Array.isArray(fo.values)) {
          cells.push(
            `${fo.column} ${fo.op ?? "in"} [${fo.values.slice(0, 4).join(", ")}]`
          );
        }
      }
      if (cells.length > 0) parts.push(`filters: ${cells.join("; ")}`);
    }
  }
  if (typeof top.question_override === "string" && top.question_override.length) {
    parts.push(
      `q: ${(top.question_override as string).slice(0, 80)}${(top.question_override as string).length > 80 ? "…" : ""}`
    );
  }
  void tool;
  return parts.join("; ");
}

function buildRagBlock(
  ctx: AgentExecutionContext,
  input: BuildSynthesisContextInput
): string {
  const parts: string[] = [];

  const upfront = input.upfrontRagHitsBlock?.trim();
  if (upfront) {
    parts.push(`# Upfront retrieval (round 1)\n${upfront}`);
  }

  const round2 =
    input.blackboard?.domainContext?.filter(
      (e) => e.source === "rag_round2"
    ) ?? [];
  if (round2.length > 0) {
    const r2Block = round2
      .map((e) => `[${e.source}:${e.id}] ${e.content.trim()}`)
      .join("\n---\n");
    parts.push(`# Findings-driven retrieval (round 2)\n${r2Block}`);
  }

  // W16 · web search hits live in the same blackboard slot under
  // `source: "web"`. They render in their own sub-section so the synthesizer
  // sees them as background grounding, never as numeric evidence. The tool
  // already formats hits with `[web:tavily:N]` prefixes, so we don't double-
  // tag them with the dc-id — just emit the content verbatim.
  const webHits =
    input.blackboard?.domainContext?.filter((e) => e.source === "web") ?? [];
  if (webHits.length > 0) {
    const webBlock = webHits.map((e) => e.content.trim()).join("\n---\n");
    parts.push(`# Web search context\n${webBlock}`);
  }

  void ctx; // reserved for future synthesis-time RAG re-call
  const joined = parts.join("\n\n").trim();
  return joined.slice(0, RAG_BLOCK_CHAR_CAP);
}

function buildUserBlock(ctx: AgentExecutionContext): string {
  const lines: string[] = [];

  if (ctx.username?.trim()) {
    lines.push(`Authenticated user: ${ctx.username.trim()}`);
  }

  if (ctx.permanentContext?.trim().length) {
    lines.push(
      `User notes (verbatim):\n${ctx.permanentContext.trim().slice(0, PERMANENT_NOTES_CAP)}`
    );
  }

  const followUps =
    ctx.sessionAnalysisContext?.suggestedFollowUps?.filter(Boolean) ?? [];
  if (followUps.length > 0) {
    lines.push("Suggested follow-ups carried from prior turns:");
    for (const f of followUps.slice(0, SUGGESTED_FOLLOWUPS_MAX)) {
      lines.push(`  • ${f}`);
    }
  }

  return lines.join("\n").trim();
}

/**
 * Format the bundle as a single labelled markdown string for inclusion in
 * the synthesis user prompt. Empty blocks are omitted so the prompt stays
 * minimal when signals are missing.
 */
export function formatSynthesisContextBundle(
  bundle: SynthesisContextBundle
): string {
  const sections: string[] = [];

  if (bundle.dataUnderstandingBlock) {
    sections.push(`## DATA UNDERSTANDING\n${bundle.dataUnderstandingBlock}`);
  }
  if (bundle.userBlock) {
    sections.push(`## USER CONTEXT\n${bundle.userBlock}`);
  }
  if (bundle.ragBlock) {
    sections.push(
      // W16 · clarify that web hits (when present) follow the same rule as
      // RAG hits — background grounding, never numeric evidence. Citations
      // can use the [web:tavily:N] tags the tool emitted.
      `## RELATED CONTEXT (RAG / web)\nUse for grounding and citation only — never as numeric evidence. RAG and web tags (\`[web:tavily:N]\`) may be cited inline when the framing is material.\n${bundle.ragBlock}`
    );
  }
  if (bundle.domainBlock) {
    sections.push(
      `## DOMAIN KNOWLEDGE (FMCG / Marico)\nAuthored background. Cite the pack id (e.g. \`marico-haircare-portfolio\`) when you reference it. Treat as orientation only — never as numeric evidence; tool output is authoritative for figures.\n${bundle.domainBlock}`
    );
  }

  return sections.join("\n\n").trim();
}
