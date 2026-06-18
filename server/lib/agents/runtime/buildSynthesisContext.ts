/**
 * ============================================================================
 * buildSynthesisContext.ts — gather all the background context the answer-writers
 *                          need into four tidy, labelled text blocks
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Before the agent writes its final answer, it needs background context: what
 *   the dataset actually is, who the user is, any related knowledge pulled from
 *   search (RAG = retrieval-augmented generation; "RAG hits" are relevant
 *   documents found for the question), and authored FMCG/Marico domain knowledge.
 *   This file collects all of that from places the app already computed it and
 *   formats it into four clearly-labelled markdown sections: DATA UNDERSTANDING,
 *   USER CONTEXT, RELATED CONTEXT (RAG / web), and DOMAIN KNOWLEDGE. Each block
 *   is independently optional — if a signal is missing, that block is empty and
 *   gets dropped, so the prompt stays minimal. Very large inputs are softly
 *   length-capped (and each truncation is recorded so the UI can tell the user
 *   "we trimmed some context").
 *
 * WHY IT MATTERS
 *   Both answer-writers — the narrator and the synthesizer — consume the SAME
 *   bundle from this one place. That matters for two reasons: (1) consistency —
 *   both writers see identical context; (2) prompt caching — because the bundle
 *   is built in stable byte-order, the prompt prefix stays identical across calls
 *   in a turn, which lets the LLM provider reuse cached tokens (cheaper, faster).
 *   Centralising also means new context sources get wired into both writers in
 *   one edit rather than two. A key behaviour: it surfaces per-tool-call SCOPE
 *   (which step filtered to a subset vs. queried everything) so the writer doesn't
 *   wrongly conclude "the data is incomplete" from one filtered step's output.
 *
 * KEY PIECES
 *   - buildSynthesisContext(ctx, input) — main builder; returns the four-block
 *     SynthesisContextBundle.
 *   - formatSynthesisContextBundle(bundle) — render the bundle into one labelled
 *     markdown string for the prompt, omitting empty sections.
 *   - SynthesisContextBundle / BuildSynthesisContextInput — the output and input
 *     shapes (input can include upfront RAG hits, the blackboard, a trim sink,
 *     and structured tool observations).
 *   - buildDomainBlock / buildDataUnderstandingBlock / buildRagBlock /
 *     buildUserBlock — one private builder per section.
 *   - formatToolScope(tool, args) — render a tool call's filters/groupBy compactly.
 *
 * HOW IT CONNECTS
 *   Reads from AgentExecutionContext (./types.js) and the AnalyticalBlackboard
 *   (./analyticalBlackboard.js). Uses applyCap / TrimmedBlockInfo
 *   (./promptBudget.js) for soft length limits with truncation reporting. Its
 *   output is consumed by narratorAgent.ts (and the synthesizer) to build the
 *   final answer prompt.
 */
import type { AgentExecutionContext } from "./types.js";
import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";
import { applyCap, type TrimmedBlockInfo } from "./promptBudget.js";

// These caps are SOFT defaults wrapped in `applyCap`. They bound very-large
// MACHINE / AUTHORED inputs (the RAG bundle, the authored FMCG/Marico domain
// packs) so the prompt body can't balloon past the model window.
//
// User-PROVIDED context is intentionally NOT capped: the user's "Give Additional
// Context" note (ctx.permanentContext) and the derived stated-intent / interpreted
// constraints are surfaced VERBATIM in `buildUserBlock` — they reach the writer in
// full in every step. (Earlier this file capped permanent notes at 4 000 chars,
// which is what made a "context trimmed" notice fire for ordinary-length notes.)
const DOMAIN_BLOCK_CHAR_CAP = 9_000;
const RAG_BLOCK_CHAR_CAP = 9_000;
const COLUMN_ROLES_MAX = 20;
const SUGGESTED_FOLLOWUPS_MAX = 4;

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
  /** Optional formatted RAG block from the upfront retrieval. */
  upfrontRagHitsBlock?: string;
  /** Optional analytical blackboard — `domainContext` entries surface here as RAG round-2 hits. */
  blackboard?: AnalyticalBlackboard;
  /** Optional sink that collects per-block truncation events. When provided,
   *  the bundle pushes one `TrimmedBlockInfo` per cap site that actually
   *  truncated. The caller emits the coalesced SSE row. */
  contextTrimmedSink?: TrimmedBlockInfo[];
  /**
   * Structured tool I/O captured by the agent loop. Lets the narrator's
   * data-understanding block list each step's tool, args (filter / groupBy /
   * etc.), output row count, and aggregation flag — so the narrator can tell
   * "this step queried all four regions" from "this step filtered to Central
   * only" instead of guessing from text observations.
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
    /**
     * The full ToolResult (typed `unknown` on StructuredObservation). When the
     * step is a SMALL aggregated result (e.g. a 24-row ASM ranking), its complete
     * `result.table.rows` are surfaced verbatim to the writer so it can state a
     * full ranking instead of hedging "only partially shown in the snippet".
     */
    result?: unknown;
  }>;
}

// Full result rows are surfaced ONLY for small aggregated steps — a 24-row ASM
// ranking should reach the writer intact, but a 5k-row raw projection must keep
// riding on the (capped) observation text so the prompt doesn't balloon.
const QUERY_RESULTS_MAX_ROWS_PER_STEP = 50;
const QUERY_RESULTS_PER_STEP_CHAR_CAP = 8_000;
const QUERY_RESULTS_BLOCK_CHAR_CAP = 24_000;

/** Defensively pull `{rows, columns}` from an unknown ToolResult. */
function extractTableRowsAndColumns(
  result: unknown
): { rows: Record<string, unknown>[]; columns: string[] } | null {
  if (!result || typeof result !== "object") return null;
  const t = (result as { table?: unknown }).table;
  if (!t || typeof t !== "object") return null;
  const rawRows = (t as { rows?: unknown }).rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) return null;
  const rows = rawRows as Record<string, unknown>[];
  const rawCols = (t as { columns?: unknown }).columns;
  const columns = Array.isArray(rawCols)
    ? rawCols.filter((c): c is string => typeof c === "string")
    : Object.keys(rows[0] ?? {});
  return { rows, columns };
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
    domainBlock: buildDomainBlock(ctx, input),
    dataUnderstandingBlock: buildDataUnderstandingBlock(ctx, input),
    ragBlock: buildRagBlock(ctx, input),
    userBlock: buildUserBlock(ctx, input),
  };
}

function buildDomainBlock(
  ctx: AgentExecutionContext,
  input: BuildSynthesisContextInput
): string {
  const raw = ctx.domainContext?.trim();
  if (!raw) return "";
  const { content, trimmed } = applyCap(
    "synthesis.domainBlock",
    raw,
    DOMAIN_BLOCK_CHAR_CAP
  );
  if (trimmed) input.contextTrimmedSink?.push(trimmed);
  return content;
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

  // When the dataset was melted from wide format at upload, surface the
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

  // Time-of-day columns are HH:MM:SS strings (no calendar date), not dates.
  // The narrator must phrase them as clock times ("9:30 AM cutoff",
  // "average clock-in 09:45") and never reach for date-arithmetic phrasing.
  const todColumns = (summary?.columns ?? []).filter(
    (c) => c.timeOfDay !== undefined,
  );
  if (todColumns.length > 0) {
    const todList = todColumns
      .map((c) => {
        const sentinels = c.timeOfDay?.sentinelValues ?? [];
        return sentinels.length
          ? `"${c.name}" (excludes ${sentinels.join(", ")} as non-time placeholders)`
          : `"${c.name}"`;
      })
      .join("; ");
    lines.push(
      `Time-of-day columns: ${todList}. These are HH:MM:SS strings, not calendar dates — ` +
        `phrase findings as clock times (e.g. "before 9:30 AM", "average clock-in 09:45") ` +
        `and never frame them as dates.`,
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

  // What view the user is currently looking at on the most recent assistant
  // message. Lets the narrator phrase the answer relative to
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

  // Per-step tool scope so the narrator can distinguish "this step queried the
  // whole dataset" from "this step filtered to a subset". Without this surface,
  // the narrator concludes "data is incomplete" when looking only at a filtered
  // tool's output text. Each line lists tool name + dimensionFilters / groupBy
  // / outputRowCount.
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

  // Complete result rows for SMALL aggregated steps. Without this, the writer
  // only sees the (top-K, char-capped) observation snippet and wrongly hedges
  // that "a full ranking cannot be stated from the supplied evidence" — even for
  // a 24-row ASM breakdown that fits easily. These rows are authoritative.
  const fullRowsLines: string[] = [];
  let fullRowsChars = 0;
  for (const o of obs.slice(-12)) {
    if (!o.metrics.appliedAggregation) continue;
    const outN = o.metrics.outputRowCount;
    if (typeof outN === "number" && outN > QUERY_RESULTS_MAX_ROWS_PER_STEP) continue;
    const extracted = extractTableRowsAndColumns(o.result);
    if (!extracted || extracted.rows.length > QUERY_RESULTS_MAX_ROWS_PER_STEP) continue;
    const scope = formatToolScope(o.tool, o.args);
    const json = JSON.stringify(extracted.rows).slice(0, QUERY_RESULTS_PER_STEP_CHAR_CAP);
    const entry = `  • ${o.stepId} ${o.tool}${scope ? ` — ${scope}` : ""} (${extracted.rows.length} rows, COMPLETE):\n    ${json}`;
    if (fullRowsChars + entry.length > QUERY_RESULTS_BLOCK_CHAR_CAP) break;
    fullRowsChars += entry.length;
    fullRowsLines.push(entry);
  }
  if (fullRowsLines.length > 0) {
    lines.push(
      "Complete results for small aggregated steps (authoritative — state full rankings/lists directly from these rows; do NOT claim a result is 'only partially shown' or 'cannot be stated from the supplied evidence'):"
    );
    lines.push(...fullRowsLines);
  }

  return lines.join("\n").trim();
}

/**
 * Render the meaningful scope-defining args of a tool call as a compact line
 * for the narrator. Surfaces dimensionFilters (so the narrator sees "filtered
 * to Central"), groupBy, plan-level dimensionFilters, etc.
 *
 * Best-effort — when args don't fit a known shape, returns "" and the narrator
 * just sees the row count.
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

  // Web search hits live in the same blackboard slot under `source: "web"`.
  // They render in their own sub-section so the synthesizer sees them as
  // background grounding, never as numeric evidence. The tool already formats
  // hits with `[web:tavily:N]` prefixes, so we don't double-tag them with the
  // dc-id — just emit the content verbatim.
  const webHits =
    input.blackboard?.domainContext?.filter((e) => e.source === "web") ?? [];
  if (webHits.length > 0) {
    const webBlock = webHits.map((e) => e.content.trim()).join("\n---\n");
    parts.push(`# Web search context\n${webBlock}`);
  }

  void ctx; // reserved for future synthesis-time RAG re-call
  const joined = parts.join("\n\n").trim();
  const { content: ragOut, trimmed: ragTrim } = applyCap(
    "synthesis.ragBlock",
    joined,
    RAG_BLOCK_CHAR_CAP
  );
  if (ragTrim) input.contextTrimmedSink?.push(ragTrim);
  return ragOut;
}

function buildUserBlock(
  ctx: AgentExecutionContext,
  input: BuildSynthesisContextInput
): string {
  const lines: string[] = [];

  if (ctx.username?.trim()) {
    lines.push(`Authenticated user: ${ctx.username.trim()}`);
  }

  if (ctx.permanentContext?.trim().length) {
    // User-provided "Give Additional Context" — surfaced VERBATIM, never capped.
    lines.push(`User notes (verbatim):\n${ctx.permanentContext.trim()}`);
  }

  // Surface userIntent.{verbatimNotes, interpretedConstraints} explicitly, so
  // the narrator always sees them. (Relying on the hypothesis planner to encode
  // them in the blackboard loses them when the blackboard is empty — the
  // synthesis-fallback path — or thin, e.g. a single-tool turn.) They ALWAYS
  // appear in the user block when set, IN FULL — this is user-derived content
  // and is never capped.
  const userIntent = ctx.sessionAnalysisContext?.userIntent;
  if (userIntent) {
    const verbatim = (userIntent.verbatimNotes ?? "").trim();
    if (verbatim) {
      lines.push(
        `User-stated intent (verbatim from earlier turns):\n${verbatim}`
      );
    }
    const constraints = (userIntent.interpretedConstraints ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (constraints.length) {
      lines.push("User-stated constraints (interpreted from prior turns):");
      for (const c of constraints) {
        lines.push(`  • ${c}`);
      }
    }
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
