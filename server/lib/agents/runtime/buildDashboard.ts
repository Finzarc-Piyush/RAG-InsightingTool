/**
 * ============================================================================
 * buildDashboard.ts — auto-builds a multi-sheet dashboard from a chat answer
 * ============================================================================
 * WHAT THIS FILE DOES
 *   After the agent has answered a question (and drawn some charts), this file
 *   can automatically assemble those charts, KPI numbers, and narrative into a
 *   two-sheet "dashboard" — a saveable, shareable report. A "DashboardSpec" is
 *   the JSON blueprint of that dashboard (which sheets, which charts on each,
 *   what text blocks). One LLM call writes the narrative/curation; the rest of
 *   the layout (which charts are featured, the KPI strip, etc.) is filled in
 *   deterministically by code so it's predictable.
 *
 *   The two sheets it always builds:
 *     - "Executive Summary": a KPI strip + LLM-curated narrative + a data-driven
 *       number of featured charts (decided from analytical breadth) + the pivot.
 *     - "All Artefacts": every chart from the turn + the pivot (deterministic).
 *
 * WHY IT MATTERS
 *   It turns a one-off chat answer into a durable artefact the user can confirm
 *   and persist. The function NEVER throws: if the LLM call fails (bad JSON,
 *   network error), it falls back to a deterministic spec built from the same
 *   inputs, so the user always gets a dashboard once the gate decides to build
 *   one. The gate (should we build? for whom?) lives in a separate file so it
 *   can be unit-tested without loading the OpenAI client.
 *
 * KEY PIECES
 *   - buildDashboardFromTurn — public entry. Builds prompts, calls the LLM,
 *     decorates the result (or fallback) into the final DashboardSpec.
 *   - buildFallbackSpec — deterministic minimal spec used when the LLM fails.
 *   - pickFeaturedCharts — chooses a data-driven number of charts for the
 *     Executive Summary (priority: "Top drivers of…" → first time-series →
 *     breadth), counted by the shared dashboardLayout authority.
 *   - buildAllArtefactsNarrativeBlocks — now a hard no-op (returns []); see its
 *     own comment for why the per-step "Step N" blocks were removed.
 *   - Re-exports: prompt builders (from buildDashboardPrompt.js) and the gate
 *     functions (from dashboardAutogenGate.js) for backward-compatible imports.
 *
 * HOW IT CONNECTS
 *   Called from the agent loop after synthesis when the autogen gate fires
 *   (flag on + the analysis brief requested a dashboard + at least one chart
 *   exists). Prompts come from buildDashboardPrompt.js; the KPI strip from
 *   kpiStripBlock.js; final layout polish from dashboardTemplates.js. The
 *   resulting spec rides on AgentLoopResult.dashboardDraft and the client
 *   later POSTs it to /api/dashboards/from-spec to persist into Cosmos.
 */
import { randomUUID } from "crypto";

import {
  dashboardSpecSchema,
  type AnalysisBrief,
  type ChartSpec,
  type DashboardAnswerEnvelope,
  type DashboardNarrativeBlock,
  type DashboardPivotSpec,
  type DashboardSheetSpec,
  type DashboardSpec,
  type DashboardTemplate,
  type InvestigationSummary,
  type PriorInvestigationItem,
  type DataSummary,
  type DashboardScorecardSpec,
} from "../../../shared/schema.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import { isFlagOn } from "../../featureFlags.js";
import { selectScorecardMetrics } from "../../scorecard/selectScorecardMetrics.js";
import { computeScorecard } from "../../scorecard/computeScorecard.js";
import {
  decideFeaturedCount,
  selectFeaturedCharts,
  type DepthBudget,
} from "../../../shared/dashboardLayout.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { agentLog } from "./agentLogger.js";
import { applyDashboardTemplateLayout } from "./dashboardTemplates.js";
import {
  buildDashboardSystemPrompt as buildSystemPrompt,
  buildDashboardUserPrompt as buildUserPrompt,
} from "./buildDashboardPrompt.js";
import { buildKpiStripBlock } from "./kpiStripBlock.js";
import { computeAttentionAreas } from "./computeAttentionAreas.js";
import { attachOrgAverageReferenceLines } from "./attachReferenceLines.js";
import { errorMessage } from "../../../utils/errorMessage.js";

// Re-export the pure prompt builders so existing call sites that import them
// from this module keep working. Tests should import directly from
// ./buildDashboardPrompt.js to avoid pulling the OpenAI client at module load.
export {
  buildDashboardSystemPrompt,
  buildDashboardUserPrompt,
  DASHBOARD_SYSTEM_PROMPT,
} from "./buildDashboardPrompt.js";

/** Magnitudes live on AgentLoopResult; redeclared inline to match the
 *  messageSchema.magnitudes shape without requiring a type export from
 *  shared/schema.ts. */
type MagnitudeLike = {
  label: string;
  value: string;
  confidence?: "low" | "medium" | "high";
};

export interface BuildDashboardArgs {
  question: string;
  answerBody: string;
  keyInsight?: string;
  charts: ChartSpec[];
  magnitudes?: MagnitudeLike[];
  brief?: AnalysisBrief;
  /**
   * The turn's depth budget (queryIntentAuthority, invariant #12). Modulates how
   * many charts the Executive Summary sheet features — a quick lookup stays lean,
   * a deep ask earns full breadth. Optional; defaults to generous when absent.
   */
  depthBudget?: DepthBudget;
  turnId: string;
  onLlmCall: () => void;
  /**
   * Per-tool result summaries from THIS turn's planner, in execution order.
   * Strings shaped like "tool_name: <result.summary>". Surfaced into the
   * narrative LLM so the dashboard can cite the intermediate analytical
   * findings (not just the final answer body) when telling the story across
   * tiles.
   */
  intermediateSummaries?: string[];
  /**
   * Slim AnswerEnvelope from the narrator (TL;DR, findings, recommendations,
   * methodology, caveats). Threaded into the prompt (so the Executive Summary
   * narrative can reuse findings/recommendations verbatim) AND persisted on the
   * resulting `DashboardSpec` so the export can render cover/exec-summary/
   * methodology slides.
   */
  envelope?: DashboardAnswerEnvelope;
  /**
   * The user's frozen pivot snapshot for this turn. When provided the dashboard
   * runtime appends it to the All Artefacts sheet and (when the LLM cites it)
   * to the Executive Summary sheet.
   */
  pivot?: DashboardPivotSpec;
  /**
   * Message-mirroring fields populated synchronously at auto-create.
   * `businessActions` is intentionally NOT here — it resolves post-verifier
   * via a Promise on `AgentLoopResult`, so the dashboard receives it via
   * `patchDashboardBusinessActions` after initial persist.
   *
   * These three are stamped verbatim onto the returned `DashboardSpec`
   * (see `runDashboardCompletion`) — they are deterministic spec metadata,
   * not narrative inputs to the LLM, so the prompt is unaffected.
   */
  followUpPrompts?: string[];
  investigationSummary?: InvestigationSummary;
  priorInvestigationsSnapshot?: PriorInvestigationItem[];
  /**
   * Wave W6 (data-bound cards) · dataset context for the Executive-Summary KPI
   * scorecards. When `SCORECARD_EXEC_SUMMARY_ENABLED` is on AND all three are
   * present, the band is built from REAL dataset queries (value + PoP delta +
   * sparkline) instead of the free-typed `magnitudes` KPI strip. Optional +
   * back-compat: absent → the legacy KPI strip path is unchanged.
   */
  summary?: DataSummary;
  sessionId?: string;
  chatDocument?: ChatDocument | null;
}

/**
 * Wave W6 · build + compute the Executive-Summary KPI scorecard band from real
 * dataset queries and stamp it onto the spec. Returns true when scorecards were
 * attached (so the caller suppresses the legacy free-typed KPI strip). Never
 * throws — on any failure it returns false and the KPI strip path takes over.
 */
async function attachExecScorecards(
  spec: DashboardSpec,
  args: BuildDashboardArgs
): Promise<boolean> {
  if (!isFlagOn("SCORECARD_EXEC_SUMMARY_ENABLED")) return false;
  if (!args.summary || !args.sessionId) return false;
  try {
    const model = args.chatDocument?.semanticModel ?? null;
    const defs = selectScorecardMetrics({
      summary: args.summary,
      charts: args.charts,
      model,
      max: 6,
    });
    if (defs.length === 0) return false;
    const loadRows = args.chatDocument
      ? async () => {
          const { loadLatestData } = await import("../../../utils/dataLoader.js");
          return (await loadLatestData(args.chatDocument!)) as Record<string, any>[];
        }
      : undefined;
    const scorecards: DashboardScorecardSpec[] = await Promise.all(
      defs.map(async (d) => ({
        ...d,
        snapshot: await computeScorecard(d, {
          summary: args.summary!,
          sessionId: args.sessionId,
          chat: args.chatDocument,
          model,
          loadRows,
        }),
      }))
    );
    spec.scorecards = scorecards;
    return true;
  } catch (err) {
    agentLog("buildDashboard.scorecards_failed", {
      turnId: args.turnId,
      error: errorMessage(err),
    });
    return false;
  }
}

// Pure-logic gating lives in ./dashboardAutogenGate.ts so it can be
// unit-tested without loading the openai module. Re-exported here for
// backward compatibility with the existing call sites.
export {
  isDashboardAutogenEnabled,
  dashboardAutogenRolloutPct,
  isUserEnrolledInDashboardAutogenRollout,
  shouldBuildDashboard,
  dashboardBuildDecision,
} from "./dashboardAutogenGate.js";


/**
 * Produce a DashboardSpec from the current turn's artifacts. Never throws —
 * a failure returns null and the agent loop treats that as "no draft emitted".
 */
export async function buildDashboardFromTurn(
  args: BuildDashboardArgs
): Promise<DashboardSpec | null> {
  const system = buildSystemPrompt();
  // Convert the structured pivot snapshot into a one-line summary for the
  // prompt. The pivot itself is materialised onto sheets in W8.
  const pivotSummary = args.pivot ? summarisePivotForPrompt(args.pivot) : undefined;
  const user = buildUserPrompt({ ...args, pivotSummary });
  return runDashboardCompletion(system, user, args);
}

/** Find the named sheet on the spec, or create it if missing. The LLM
 *  is supposed to emit both sheets — this is a belt-and-braces guard. */
function pickOrCreateSheet(
  spec: DashboardSpec,
  id: string,
  name: string
): DashboardSheetSpec {
  const idx = spec.sheets.findIndex(
    (s) => s.id === id || s.name.toLowerCase() === name.toLowerCase()
  );
  if (idx >= 0) {
    spec.sheets[idx] = { ...spec.sheets[idx], id, name };
    return spec.sheets[idx];
  }
  const sheet: DashboardSheetSpec = { id, name, charts: [] };
  spec.sheets.push(sheet);
  return sheet;
}

/**
 * Featured-chart picker for the Executive Summary sheet. The COUNT is no longer
 * a hardcoded 3 — it is decided by the shared layout authority from the number
 * of distinct analytical angles the turn produced (bounded by the depth budget
 * and a comfortable grid ceiling). The ORDER preserves the legacy priority
 * (top-drivers tile → first time-series → breadth) and dedupes exact repeats.
 * Returns the same `ChartSpec` objects so chart data and provenance stay intact.
 * See dashboardLayout.ts (decideFeaturedCount / selectFeaturedCharts).
 */
function pickFeaturedCharts(
  authoritative: ChartSpec[],
  template: DashboardTemplate,
  depthBudget?: DepthBudget,
): ChartSpec[] {
  const count = decideFeaturedCount(authoritative, { template, depthBudget });
  return selectFeaturedCharts(authoritative, count);
}

/** Intentionally a hard no-op: always returns `[]`.
 *
 *  This used to emit one "Step N" narrative block per intermediate tool
 *  summary onto the All Artefacts sheet. Those blocks dumped raw tool-call
 *  summaries (e.g. `get_schema_summary: rows=9800 columns=…`,
 *  `execute_query_plan: Grouped by Region with sum(Sales)…`) which are
 *  internal audit data, not a user-facing artefact, so they were removed.
 *
 *  The function is kept (not deleted) so the existing call sites compile
 *  unchanged and the regression test continues to pin "no Step N blocks ever
 *  surface". The `intermediateSummaries` argument is preserved on the signature
 *  for the same reason; if ever re-used it should feed a different artefact
 *  (a structured per-step audit log on the agent trace, not a narrative block
 *  on a user dashboard).
 *
 *  Exported for unit tests so the no-op has a focused regression guard. */
export function buildAllArtefactsNarrativeBlocks(
  // Kept on the signature for back-compat; deliberately unused — see comment above.
  _intermediateSummaries: string[] | undefined
): DashboardNarrativeBlock[] {
  return [];
}

/**
 * Strip narrative blocks whose title matches one of the banned boilerplate
 * tiles. The LLM sometimes still emits these despite the prompt rule, so this
 * is the durable guarantee. Mutates the spec in place.
 */
const BANNED_NARRATIVE_TITLES = new Set([
  "methodology",
  "how to read this dashboard",
  "original question",
]);

function stripBannedNarrativeBlocks(spec: DashboardSpec): void {
  for (const sheet of spec.sheets) {
    if (!Array.isArray(sheet.narrativeBlocks)) continue;
    sheet.narrativeBlocks = sheet.narrativeBlocks.filter((b) => {
      const title = (b.title ?? "").trim().toLowerCase();
      return !BANNED_NARRATIVE_TITLES.has(title);
    });
  }
}

function summarisePivotForPrompt(p: DashboardPivotSpec): string {
  const cfg = p.pivotConfig;
  const rows = (cfg?.rows ?? []).join(" × ");
  const cols = (cfg?.columns ?? []).join(" × ");
  const vals = (cfg?.values ?? [])
    .map((v) => `${v.field} (${v.agg})`)
    .join(", ");
  const parts: string[] = [];
  parts.push(`title: ${p.title}`);
  if (rows) parts.push(`rows: ${rows}`);
  if (cols) parts.push(`columns: ${cols}`);
  if (vals) parts.push(`values: ${vals}`);
  return parts.join(" · ");
}

async function runDashboardCompletion(
  system: string,
  user: string,
  args: BuildDashboardArgs
): Promise<DashboardSpec | null> {
  // MW5 · attach an "Org avg" benchmark reference line to each categorical
  // breakdown so a manager sees who is above/below average at a glance. Uses
  // copies (dashboard-only — chat-surface charts are unaffected).
  args = { ...args, charts: attachOrgAverageReferenceLines(args.charts ?? []) };
  try {
    const out = await completeJson(system, user, dashboardSpecSchema, {
      turnId: `${args.turnId}_dashdraft`,
      temperature: 0.2,
      maxTokens: 2200,
      onLlmCall: args.onLlmCall,
      purpose: LLM_PURPOSE.BUILD_DASHBOARD,
    });
    let spec: DashboardSpec;
    if (!out.ok) {
      // On LLM parse failure, build a deterministic fallback spec from the same
      // inputs the runtime would have decorated, rather than dropping the
      // dashboard silently. The user always gets a dashboard when the gate fired.
      agentLog("buildDashboard.parse_failed_fallback", {
        turnId: args.turnId,
        error: out.error.slice(0, 400),
      });
      spec = buildFallbackSpec(args);
    } else {
      spec = out.data;
    }

    stripBannedNarrativeBlocks(spec);

    // 2-sheet structure:
    //   - Sheet 1 ("Executive Summary"): LLM-curated narrative. Server adds
    //     featured charts + pivot deterministically + KPI strip prepended.
    //   - Sheet 2 ("All Artefacts"): server-built. Every chart from the turn
    //     + the pivot + step-insight narrative blocks.
    const summarySheet = pickOrCreateSheet(spec, "sheet_summary", "Executive Summary");
    const allSheet = pickOrCreateSheet(spec, "sheet_all", "All Artefacts");

    // ---- Sheet 1: Executive Summary ----
    // Always populate charts/pivots deterministically — the prompt tells the
    // LLM NOT to emit them, so any leftover artefacts on the LLM's sheet are
    // discarded.
    summarySheet.charts = pickFeaturedCharts(args.charts, spec.template, args.depthBudget);
    summarySheet.pivots = args.pivot ? [args.pivot] : [];

    // Wave W6 · prefer DATA-BOUND KPI scorecards (real value + PoP delta +
    // sparkline). When attached, suppress the legacy free-typed KPI strip.
    const scored = await attachExecScorecards(spec, args);
    if (!scored) {
      // Prepend the deterministic KPI strip from envelope magnitudes (or the
      // legacy magnitudes argument). Idempotent — replaces any prior block
      // titled "Headline numbers".
      const kpiBlock = buildKpiStripBlock(args.envelope?.magnitudes ?? args.magnitudes);
      if (kpiBlock) {
        const existing = (summarySheet.narrativeBlocks ?? []).filter(
          (b) => b.title !== "Headline numbers"
        );
        summarySheet.narrativeBlocks = [kpiBlock, ...existing];
      }
    }

    // ---- Sheet 2: All Artefacts (deterministic) ----
    allSheet.charts = [...args.charts];
    allSheet.pivots = args.pivot ? [args.pivot] : [];
    allSheet.narrativeBlocks = buildAllArtefactsNarrativeBlocks(args.intermediateSummaries);

    // Stamp UUIDs on any narrative blocks lacking ids.
    for (const sheet of spec.sheets) {
      if (Array.isArray(sheet.narrativeBlocks)) {
        sheet.narrativeBlocks = sheet.narrativeBlocks.map((b) => ({
          ...b,
          id: b.id && b.id.length > 0 ? b.id : randomUUID(),
        }));
      }
    }

    if (
      !spec.defaultSheetId ||
      !spec.sheets.some((s) => s.id === spec.defaultSheetId)
    ) {
      spec.defaultSheetId = "sheet_summary";
    }

    // Attach the slim envelope so it survives the spec → from-spec → Cosmos
    // round-trip. The export pipeline reads this for cover, exec summary, and
    // methodology slides.
    if (args.envelope) {
      spec.answerEnvelope = args.envelope;
    }
    // Stamp the three synchronously-available message-mirroring fields onto the
    // spec so the from-spec persist round-trips them onto the Cosmos
    // `Dashboard` document. Deterministic — not LLM-rewritten — so the
    // dashboard view shows the same TL;DR / follow-up CTAs / digest the user
    // saw in chat.
    if (args.followUpPrompts && args.followUpPrompts.length > 0) {
      spec.followUpPrompts = args.followUpPrompts;
    }
    if (args.investigationSummary) {
      spec.investigationSummary = args.investigationSummary;
    }
    if (args.priorInvestigationsSnapshot && args.priorInvestigationsSnapshot.length > 0) {
      spec.priorInvestigationsSnapshot = args.priorInvestigationsSnapshot;
    }
    // MW4 · management-by-exception — flag below-org-average units from the
    // breakdown charts so the dashboard can lead with an "Attention Areas"
    // callout (the problem areas to act on first). Deterministic, derived from
    // the displayed charts, so it never contradicts a tile.
    const attentionAreas = computeAttentionAreas(args.charts ?? []);
    if (attentionAreas.length > 0) spec.attentionAreas = attentionAreas;

    applyDashboardTemplateLayout(spec);
    return spec;
  } catch (err) {
    // On network/runtime errors, build a deterministic fallback so the user
    // still sees a draft + auto-persist rather than dropping the dashboard.
    agentLog("buildDashboard.threw_fallback", {
      turnId: args.turnId,
      error: errorMessage(err),
    });
    try {
      const spec = buildFallbackSpec(args);
      const summarySheet = pickOrCreateSheet(spec, "sheet_summary", "Executive Summary");
      const allSheet = pickOrCreateSheet(spec, "sheet_all", "All Artefacts");
      summarySheet.charts = pickFeaturedCharts(args.charts, spec.template, args.depthBudget);
      summarySheet.pivots = args.pivot ? [args.pivot] : [];
      const kpi = buildKpiStripBlock(args.envelope?.magnitudes ?? args.magnitudes);
      if (kpi) {
        summarySheet.narrativeBlocks = [
          kpi,
          ...(summarySheet.narrativeBlocks ?? []).filter(
            (b) => b.title !== "Headline numbers"
          ),
        ];
      }
      allSheet.charts = [...args.charts];
      allSheet.pivots = args.pivot ? [args.pivot] : [];
      allSheet.narrativeBlocks = buildAllArtefactsNarrativeBlocks(args.intermediateSummaries);
      for (const sheet of spec.sheets) {
        if (Array.isArray(sheet.narrativeBlocks)) {
          sheet.narrativeBlocks = sheet.narrativeBlocks.map((b) => ({
            ...b,
            id: b.id && b.id.length > 0 ? b.id : randomUUID(),
          }));
        }
      }
      spec.defaultSheetId = "sheet_summary";
      if (args.envelope) spec.answerEnvelope = args.envelope;
      // Same stamp on the LLM-failure fallback path so a network hiccup doesn't
      // strip the message-mirroring fields.
      if (args.followUpPrompts && args.followUpPrompts.length > 0) {
        spec.followUpPrompts = args.followUpPrompts;
      }
      if (args.investigationSummary) {
        spec.investigationSummary = args.investigationSummary;
      }
      if (args.priorInvestigationsSnapshot && args.priorInvestigationsSnapshot.length > 0) {
        spec.priorInvestigationsSnapshot = args.priorInvestigationsSnapshot;
      }
      const attentionAreasFb = computeAttentionAreas(args.charts ?? []);
      if (attentionAreasFb.length > 0) spec.attentionAreas = attentionAreasFb;
      applyDashboardTemplateLayout(spec);
      return spec;
    } catch (fallbackErr) {
      agentLog("buildDashboard.fallback_threw", {
        turnId: args.turnId,
        error: errorMessage(fallbackErr),
      });
      return null;
    }
  }
}

/**
 * Deterministic minimal `DashboardSpec` used when the LLM call fails (parse
 * error, network, or anything inside `completeJson`). Same downstream
 * decoration applies — the caller fills in featured charts, pivot, KPI
 * block, Sheet 2 charts/pivots/narrative — but here we have to provide
 * valid Sheet 1 narrative content so the result is still useful.
 */
function buildFallbackSpec(args: BuildDashboardArgs): DashboardSpec {
  const env = args.envelope;
  const narrativeBlocks: DashboardNarrativeBlock[] = [];

  const tldrLine = env?.tldr ? env.tldr : args.keyInsight ?? "";
  const summaryBody = tldrLine
    ? tldrLine
    : (args.answerBody ?? "").slice(0, 1200) || "Analysis complete — see charts on the All Artefacts sheet.";
  narrativeBlocks.push({
    id: randomUUID(),
    role: "summary",
    title: "Key conclusion",
    body: summaryBody.slice(0, 1500),
    order: 1,
  });

  if (env?.recommendations?.length) {
    const lines = env.recommendations.slice(0, 4).map((r) => {
      const horizonLabel =
        r.horizon === "this_quarter"
          ? "This quarter"
          : r.horizon === "strategic"
            ? "Strategic"
            : "Now";
      return `- **${horizonLabel}** — ${r.action} (${r.rationale})`;
    });
    narrativeBlocks.push({
      id: randomUUID(),
      role: "recommendations",
      title: "Recommendations",
      body: lines.join("\n").slice(0, 1500),
      order: 2,
    });
  }

  if (env?.caveats?.length) {
    narrativeBlocks.push({
      id: randomUUID(),
      role: "limitations",
      title: "Limitations",
      body: env.caveats.map((c) => `- ${c}`).join("\n").slice(0, 1500),
      order: 3,
    });
  }

  const name = (() => {
    const q = (args.question ?? "").trim();
    if (!q) return "Analysis dashboard";
    return q.slice(0, 200);
  })();

  return {
    name,
    template: "deep_dive",
    defaultSheetId: "sheet_summary",
    question: (args.question ?? "").slice(0, 4000),
    sheets: [
      {
        id: "sheet_summary",
        name: "Executive Summary",
        charts: [],
        narrativeBlocks,
      },
      {
        id: "sheet_all",
        name: "All Artefacts",
      },
    ],
  };
}
