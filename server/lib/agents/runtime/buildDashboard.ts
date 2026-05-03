/**
 * Phase 2 — buildDashboard
 *
 * Runs after synthesis when:
 *   - DASHBOARD_AUTOGEN_ENABLED=true, AND
 *   - ctx.analysisBrief.requestsDashboard === true, AND
 *   - this turn produced at least one chart (nothing useful to dashboard otherwise).
 *
 * One LLM call produces a DashboardSpec whose sheet layout mirrors the
 * Cosmos DashboardSheet shape; the client renders it as an inline preview
 * card and POSTs it to /api/dashboards/from-spec on user confirmation.
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
} from "../../../shared/schema.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { agentLog } from "./agentLogger.js";
import { applyDashboardTemplateLayout } from "./dashboardTemplates.js";
import {
  buildDashboardSystemPrompt as buildSystemPrompt,
  buildDashboardUserPrompt as buildUserPrompt,
} from "./buildDashboardPrompt.js";
import { buildKpiStripBlock } from "./kpiStripBlock.js";

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
   * W5 · slim AnswerEnvelope from the narrator. Threaded into the prompt
   * (so Sheet 1 narrative can reuse findings/recommendations verbatim) AND
   * persisted on the resulting `DashboardSpec` so the export can render
   * cover/exec-summary/methodology slides.
   */
  envelope?: DashboardAnswerEnvelope;
  /**
   * W8 · the user's frozen pivot snapshot for this turn. When provided
   * the dashboard runtime appends it to the All Artefacts sheet and
   * (when the LLM cites it) to the Executive Summary sheet.
   */
  pivot?: DashboardPivotSpec;
}

// W7.6 · Pure-logic gating moved to ./dashboardAutogenGate.ts so it can be
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
 * Deterministic featured-chart picker for Sheet 1. Priority order:
 *   1. Any chart whose title starts with "Top drivers of" (W6 tile).
 *   2. The first temporal chart (line / area).
 *   3. The first remaining chart (typically a breakdown).
 * Up to 3 charts. Returns the same `ChartSpec` objects from `authoritative`
 * so chart data and provenance stay intact.
 */
function pickFeaturedCharts(authoritative: ChartSpec[]): ChartSpec[] {
  const out: ChartSpec[] = [];
  const used = new Set<number>();

  const topDriversIdx = authoritative.findIndex((c) =>
    (c.title ?? "").toLowerCase().startsWith("top drivers of")
  );
  if (topDriversIdx >= 0) {
    out.push(authoritative[topDriversIdx]);
    used.add(topDriversIdx);
  }

  const temporalIdx = authoritative.findIndex(
    (c, i) => !used.has(i) && (c.type === "line" || c.type === "area")
  );
  if (temporalIdx >= 0) {
    out.push(authoritative[temporalIdx]);
    used.add(temporalIdx);
  }

  for (let i = 0; i < authoritative.length && out.length < 3; i++) {
    if (!used.has(i)) {
      out.push(authoritative[i]);
      used.add(i);
    }
  }

  return out;
}

/** Step-by-step narrative blocks for Sheet 2. One block per intermediate
 *  summary, untouched markdown content. */
function buildAllArtefactsNarrativeBlocks(
  intermediateSummaries: string[] | undefined
): DashboardNarrativeBlock[] {
  if (!intermediateSummaries || intermediateSummaries.length === 0) return [];
  return intermediateSummaries.slice(0, 8).map((s, i) => ({
    id: randomUUID(),
    role: "custom",
    title: `Step ${i + 1}`,
    body: s.slice(0, 1500),
    order: i,
  }));
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
      // FIX · LLM parse failure used to drop the dashboard silently. Build a
      // deterministic fallback spec from the same inputs the runtime would
      // have decorated. The user always gets a dashboard when the gate fired.
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
    // FIX · always populate charts/pivots deterministically — the new prompt
    // tells the LLM NOT to emit them, so any leftover artefacts on the LLM's
    // sheet are discarded.
    summarySheet.charts = pickFeaturedCharts(args.charts);
    summarySheet.pivots = args.pivot ? [args.pivot] : [];

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

    // W5 · attach the slim envelope so it survives the spec → from-spec →
    // Cosmos round-trip. The export pipeline reads this for cover, exec
    // summary, and methodology slides.
    if (args.envelope) {
      spec.answerEnvelope = args.envelope;
    }

    applyDashboardTemplateLayout(spec);
    return spec;
  } catch (err) {
    // FIX · network/runtime errors used to drop the dashboard silently. Build
    // a deterministic fallback so the user still sees a draft + auto-persist.
    agentLog("buildDashboard.threw_fallback", {
      turnId: args.turnId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const spec = buildFallbackSpec(args);
      const summarySheet = pickOrCreateSheet(spec, "sheet_summary", "Executive Summary");
      const allSheet = pickOrCreateSheet(spec, "sheet_all", "All Artefacts");
      summarySheet.charts = pickFeaturedCharts(args.charts);
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
      applyDashboardTemplateLayout(spec);
      return spec;
    } catch (fallbackErr) {
      agentLog("buildDashboard.fallback_threw", {
        turnId: args.turnId,
        error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
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
