/**
 * W-EXP-2 · Dashboard-export deck planner.
 *
 * Composes a `SlideDeckPlan` (W-EXP-1 schema) from a saved Dashboard. The
 * structural reasoning lives in the LLM call; the renderers (W-EXP-5/6/8/10)
 * are deterministic and unaware of layout choice — they just consume the plan.
 *
 * Architecture (locked in the approved plan):
 *   Dashboard → buildDeckPlannerUserPrompt → Claude Opus 4.7 (structured output)
 *      → SlideDeckPlan (Zod-validated; one repair round on fail)
 *      → caller renders to .pptx and .pdf in parallel
 *
 * What this agent does:
 *   - Picks layout per slide from the closed `LayoutKind` enum.
 *   - Writes action titles (verb + number, complete sentence).
 *   - Writes speaker notes (presenter cues, ≥ 20 chars).
 *   - Splits findings into one-message-per-slide chunks (the verifier in
 *     W-EXP-3 enforces this — the planner is asked to obey it up front so the
 *     repair round doesn't fire on every deck).
 *
 * What this agent does NOT do:
 *   - Pick fonts, colours, exact positions — that's the renderer's job.
 *   - Fabricate numbers — every magnitude / KPI value comes from the
 *     dashboard's own answerEnvelope or chart-level fields. The user prompt
 *     hands the planner a slim inventory; the planner cites by reference.
 *   - Fire the deterministic verifier — that's the next file (W-EXP-3) which
 *     will sit between this agent and the renderers in the controller flow.
 *
 * The system prompt is deliberately byte-stable across calls (no per-deck
 * substitutions) so the prefix cache holds — same pattern as `narratorAgent`
 * (W4.2 cache-eligibility rule).
 */

import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { agentLog } from "./agentLogger.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import {
  slideDeckPlanSchema,
  type SlideDeckPlan,
} from "../../../shared/exportSchema.js";
import type {
  ActiveFilterSpec,
  BusinessActionItem,
  ChartSpec,
  Dashboard,
  DashboardAnswerEnvelope,
  DashboardSheet,
} from "../../../shared/schema.js";

/**
 * Minimal slim-down of a Dashboard for the LLM prompt. We deliberately strip:
 *   - Inline chart `data` rows (the planner doesn't need raw points; the
 *     renderer loads them via chart-id resolution at render time).
 *   - `_agentProvenance.toolCalls` arrays — they bloat the prompt and rarely
 *     change layout choice.
 *   - `gridLayout` / responsive breakpoints — irrelevant for export.
 *
 * Surfaces ONLY the fields the planner actually needs to pick layouts and
 * write action titles. Smaller prompt = cheaper call + better focus.
 */
export interface DeckPlannerInputs {
  dashboard: Dashboard;
  /** Pre-computed ISO date so the unit test can pin a stable value. */
  generatedAt?: string;
  /** Confidentiality classification for the deck footer. Default "Internal". */
  confidentiality?: string;
  /**
   * Wave B6 · Optional ambient context the deck planner can use. Pre-B6
   * the planner saw only the dashboard contents (charts, narrative
   * blocks, answer envelope, business actions, captured filter). If the
   * user added a permanent context note AFTER the analysis was authored
   * (e.g. "flag Q1 data quality", "always include the cost-of-goods
   * caveat in exec summaries"), the deck planner had no way to honour
   * it. Same for hierarchies (BAI-style "FEMALE SHOWER GEL is a
   * category total" — must NOT show as a peer slide-vs-slide in the
   * deck) and wide-format shape (the deck must refer to Period /
   * PeriodIso / Value column names post-melt, never the original
   * wide column headers). All four optional; the upload caller resolves
   * them from the session that owns the dashboard.
   */
  permanentContext?: string;
  domainContext?: string;
  dimensionHierarchies?: Array<{
    column: string;
    rollupValue: string;
    itemValues?: string[];
    description?: string;
    source?: "user" | "auto";
  }>;
  /** Just the shape signal — the slim wide-format block, NOT the full transform metadata. */
  wideFormatShape?: {
    detected: boolean;
    shape?: "pure_period" | "compound" | "pivot_metric_row";
    periodColumn?: string;
    periodIsoColumn?: string;
    valueColumn?: string;
    metricColumn?: string;
    meltedColumns?: string[];
  };
}

interface SlimChart {
  /** Stable id used by SlideSpec.slots.chartId — stable within one render run. */
  id: string;
  type: string;
  title: string;
  /** Encoding hints for layout selection (e.g. time series → ChartWithInsight). */
  x?: string;
  y?: string;
  z?: string;
  seriesColumn?: string;
  /** Pre-existing per-chart commentary (W12 businessCommentary), surfaced verbatim. */
  insight?: string;
  businessCommentary?: string;
}

interface SlimSheet {
  id: string;
  name: string;
  charts: SlimChart[];
  narrativeSummaries: { role: string; title: string; body: string }[];
  tables: { id: string; caption: string; columnCount: number; rowCount: number }[];
}

interface SlimDashboard {
  name: string;
  generatedAt: string;
  confidentiality: string;
  answerEnvelope?: DashboardAnswerEnvelope;
  businessActions?: BusinessActionItem[];
  capturedActiveFilter?: ActiveFilterSpec;
  sheets: SlimSheet[];
  totalCharts: number;
}

/**
 * Emit a stable id for a chart. We use sheet index + chart index because
 * `ChartSpec` has no native id field — the renderer resolves slots.chartId
 * back to the same coordinates. Format `s{sheetIdx}c{chartIdx}` keeps it
 * short and grepable.
 */
function chartIdFor(sheetIdx: number, chartIdx: number): string {
  return `s${sheetIdx}c${chartIdx}`;
}

function tableIdFor(sheetIdx: number, tableIdx: number): string {
  return `s${sheetIdx}t${tableIdx}`;
}

function trimToLength(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function slimChartFromSpec(c: ChartSpec, id: string): SlimChart {
  // We deliberately accept the cast; ChartSpec carries optional fields like
  // `keyInsight` / `businessCommentary` declared in chartSpecSchema.
  const spec = c as ChartSpec & { keyInsight?: string; businessCommentary?: string };
  return {
    id,
    type: spec.type,
    title: spec.title,
    x: spec.x,
    y: spec.y,
    z: spec.z,
    seriesColumn: spec.seriesColumn,
    insight: trimToLength(spec.keyInsight, 400),
    businessCommentary: trimToLength(spec.businessCommentary, 400),
  };
}

function slimSheetFromSheet(sheet: DashboardSheet, sheetIdx: number): SlimSheet {
  const charts = (sheet.charts ?? []).map((c, i) =>
    slimChartFromSpec(c, chartIdFor(sheetIdx, i))
  );
  const narrativeSummaries = (sheet.narrativeBlocks ?? []).map((b) => ({
    role: b.role ?? "custom",
    title: b.title ?? "",
    // Cap each narrative block to 1200 chars in the prompt — the planner
    // doesn't need full prose to pick a layout. Renderers consume the full
    // body straight from the dashboard via tableId resolution.
    body: trimToLength(b.body ?? "", 1200) ?? "",
  }));
  const tables = (sheet.tables ?? []).map((t, i) => ({
    id: tableIdFor(sheetIdx, i),
    caption: t.caption ?? "",
    columnCount: t.columns?.length ?? 0,
    rowCount: t.rows?.length ?? 0,
  }));
  return {
    id: sheet.id ?? `sheet-${sheetIdx}`,
    name: sheet.name ?? `Sheet ${sheetIdx + 1}`,
    charts,
    narrativeSummaries,
    tables,
  };
}

/**
 * Build the slim representation handed to the LLM. Exported so renderers
 * (and tests) can resolve chart-ids back to their original ChartSpec via
 * `resolveChartIdToSpec` below — keeping the id-allocation logic in one
 * place prevents the renderer drifting from the planner.
 */
export function buildSlimDashboard(inputs: DeckPlannerInputs): SlimDashboard {
  const { dashboard, generatedAt, confidentiality } = inputs;
  // Backwards-compat: legacy dashboards have charts[] but no sheets[].
  const sheetsSource: DashboardSheet[] =
    dashboard.sheets && dashboard.sheets.length > 0
      ? [...dashboard.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      : [
          {
            id: "default",
            name: "Overview",
            charts: dashboard.charts ?? [],
          } as DashboardSheet,
        ];
  const sheets = sheetsSource.map((s, i) => slimSheetFromSheet(s, i));
  const totalCharts = sheets.reduce((acc, s) => acc + s.charts.length, 0);
  return {
    name: dashboard.name,
    generatedAt: generatedAt ?? new Date().toISOString().slice(0, 10),
    confidentiality: confidentiality ?? "Internal",
    answerEnvelope: dashboard.answerEnvelope,
    businessActions: dashboard.businessActions,
    capturedActiveFilter: dashboard.capturedActiveFilter,
    sheets,
    totalCharts,
  };
}

/**
 * Resolve `slots.chartId` back to its `ChartSpec`. Returns null when the id
 * doesn't correspond to a chart in the dashboard — the renderer's job is to
 * fall back gracefully (typically by skipping the slide) rather than crashing
 * the whole export.
 */
export function resolveChartIdToSpec(
  dashboard: Dashboard,
  chartId: string
): { sheetIdx: number; chartIdx: number; chart: ChartSpec } | null {
  const match = /^s(\d+)c(\d+)$/.exec(chartId);
  if (!match) return null;
  const sheetIdx = Number(match[1]);
  const chartIdx = Number(match[2]);
  const sheets =
    dashboard.sheets && dashboard.sheets.length > 0
      ? [...dashboard.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      : [
          {
            id: "default",
            name: "Overview",
            charts: dashboard.charts ?? [],
          } as DashboardSheet,
        ];
  const sheet = sheets[sheetIdx];
  if (!sheet) return null;
  const chart = sheet.charts?.[chartIdx];
  if (!chart) return null;
  return { sheetIdx, chartIdx, chart };
}

// ───────────────────────────────────────────────────────────────────────────
// System prompt — byte-stable across calls so prompt-caching kicks in.
// ───────────────────────────────────────────────────────────────────────────
//
// Action-title rules drawn from McKinsey/BCG/Bain style guides (Pyramid
// Principle, action-title-first slide structure). Every rule has a worked
// example so the model has concrete patterns to imitate.
const DECK_PLANNER_SYSTEM = `${ANALYST_PREAMBLE}You compose an executive-quality slide deck from a completed dashboard analysis.

Your output is a SlideDeckPlan in JSON form. Renderers (PowerPoint and PDF) consume the plan and produce the actual files — you do NOT pick fonts, colours, or coordinates. Your job is the STRUCTURAL REASONING and the WORDS.

YOUR CONTRACT
1. Pick \`layout\` per slide from this CLOSED enum (any other value fails validation):
   - "TitleSlide" — the cover. Always slide #1.
   - "ExecSummary" — a single-slide TL;DR with 3–5 takeaway bullets. Slide #2 by convention.
   - "KpiRow" — 2–5 KPI tiles. Pre-formatted display values (e.g. "₫68.7B", "−12%") only.
   - "ChartWithInsight" — one chart + one-sentence so-what caption. The default findings layout.
   - "TwoChartCompare" — two charts side-by-side. Use ONLY when the comparison itself is the message ("category mix vs price contribution", "trend + decomposition"). Do not use just to fit two charts on one slide.
   - "TableSlide" — native data table. Tables-as-image are forbidden by the renderer.
   - "ImplicationsByHorizon" — 3-column layout grouping implications by now / this_quarter / strategic.
   - "Recommendations" — numbered actions with horizon chip + optional confidence.
   - "Methodology" — body prose + caveats. MUST appear in the back third of the deck (never in the first half). Small font, end-of-deck styling.
   - "Appendix" — supporting charts/tables/text. Optional and explicitly labelled so the executive reader knows to skip.

2. Write \`actionTitle\` per slide. THIS IS THE SINGLE MOST IMPORTANT FIELD.
   - It MUST be a complete sentence with a verb and a number where possible.
   - Reading only the slide titles must tell the whole story (Pyramid Principle).
   - WORKED EXAMPLES (from MBB style guides):
     ✓ "Sales fell 12% in Q3 driven by category mix shift"
     ✓ "MARICO holds 9.1% share within FEMALE SHOWER GEL despite category decline"
     ✓ "Reallocate 18% of trade spend to MARICO in Q4 to hold share"
     ✗ "Sales by Quarter"               (topic title, no verb, no number)
     ✗ "Findings"                       (label, not a takeaway)
     ✗ "Performance Overview"           (vague, no message)
     ✗ "Q3 Analysis"                    (label, no message)
   - For TitleSlide and Methodology, the action title is the deck title and the methodology summary respectively — both must still be specific (e.g. "Marico-VN · category leadership · Q3 review", "Methodology · 6 weeks of Nielsen scan, 2,341 stores"). They are NOT exempt from being concrete.

3. Write \`speakerNotes\` per slide. ≥ 20 chars; ideally 2–3 sentences explaining what the chart actually shows and what to call out when presenting. The renderer attaches them as PowerPoint speaker notes / PDF footnote.

4. ONE MESSAGE PER SLIDE. If a finding has 2+ distinct numeric magnitudes that imply different conclusions, split into 2 slides. The reader's 10-second test: a slide that takes 30 seconds to grasp is two slides.

5. SECTION STRUCTURE — use this MBB template, adapted to what the dashboard contains:
   1. TitleSlide
   2. ExecSummary (TL;DR — populate \`bullets\` from \`answerEnvelope.tldr\` + the 2–4 strongest findings)
   3. KpiRow (when \`answerEnvelope.magnitudes\` has 2+ entries — surface them as tiles)
   4. Findings — one ChartWithInsight per material chart, in the order the dashboard arranges them
   5. ImplicationsByHorizon (when \`answerEnvelope.implications\` is populated)
   6. Recommendations (when \`answerEnvelope.recommendations\` AND/OR \`businessActions\` are populated; merge into one slide if total ≤ 5, two slides otherwise)
   7. Methodology (always include if \`answerEnvelope.methodology\` exists; goes in back third)
   8. Appendix (only when there are supporting charts/tables not material enough for a findings slide)

6. CHART REFERENCES — \`slots.chartId\` MUST exactly match an id in the dashboard's chart inventory (formatted "s{sheetIdx}c{chartIdx}"). Do not invent ids. Do not refer to charts that aren't in the inventory.

7. CONTENT FROM DOMAIN — when the dashboard has \`capturedActiveFilter\`, mention the filter scope in the TitleSlide subtitle or speaker notes ("filtered to: Region ∈ {North}"). When \`answerEnvelope.domainLens\` is populated, weave one phrase from it into the ExecSummary or relevant findings — never as decoration, only when it sharpens the takeaway.

8. WHAT NOT TO DO
   - Never embed raw chart data in the plan (the renderer loads it via chartId).
   - Never invent numbers not present in the dashboard (every magnitude / value field must be traceable to the dashboard's envelope or chart insights).
   - Never use generic placeholder titles ("Findings", "Analysis", "Conclusion").
   - Never put Methodology in the first half of the deck.
   - Never produce a deck of fewer than 3 slides (TitleSlide + ExecSummary + at least one chart/recommendation slide is the minimum).
   - Never produce more than 16 slides for a single dashboard — denser is harder to read; merge similar findings or move to Appendix.
`;

function formatSlimDashboardForPrompt(slim: SlimDashboard): string {
  const lines: string[] = [];
  lines.push(`# DASHBOARD\n`);
  lines.push(`Name: ${slim.name}`);
  lines.push(`Generated: ${slim.generatedAt}`);
  lines.push(`Confidentiality: ${slim.confidentiality}`);
  lines.push(`Total charts across sheets: ${slim.totalCharts}`);
  if (slim.capturedActiveFilter) {
    const conds = slim.capturedActiveFilter.conditions.map((c) => {
      if (c.kind === "in") return `${c.column} ∈ {${c.values.slice(0, 6).join(", ")}${c.values.length > 6 ? ", …" : ""}}`;
      if (c.kind === "range") return `${c.column} ${c.min ?? "−∞"}…${c.max ?? "+∞"}`;
      return `${c.column} ${c.from ?? "−∞"}…${c.to ?? "+∞"}`;
    });
    lines.push(`Captured filter: ${conds.join("; ")}`);
  }
  if (slim.answerEnvelope) {
    lines.push(`\n# ANSWER ENVELOPE\n`);
    if (slim.answerEnvelope.tldr) lines.push(`TL;DR: ${slim.answerEnvelope.tldr}`);
    if (slim.answerEnvelope.findings?.length) {
      lines.push(`\nFindings (${slim.answerEnvelope.findings.length}):`);
      slim.answerEnvelope.findings.forEach((f, i) => {
        const mag = f.magnitude ? ` [${f.magnitude}]` : "";
        lines.push(`  ${i + 1}. ${f.headline}${mag}`);
        lines.push(`     evidence: ${trimToLength(f.evidence, 600)}`);
      });
    }
    if (slim.answerEnvelope.magnitudes?.length) {
      lines.push(`\nMagnitudes (${slim.answerEnvelope.magnitudes.length}):`);
      slim.answerEnvelope.magnitudes.forEach((m) => {
        lines.push(`  - ${m.label}: ${m.value}${m.confidence ? ` (${m.confidence})` : ""}`);
      });
    }
    if (slim.answerEnvelope.implications?.length) {
      lines.push(`\nImplications (${slim.answerEnvelope.implications.length}):`);
      slim.answerEnvelope.implications.forEach((imp, i) => {
        lines.push(`  ${i + 1}. ${imp.statement} → ${imp.soWhat}${imp.confidence ? ` (${imp.confidence})` : ""}`);
      });
    }
    if (slim.answerEnvelope.recommendations?.length) {
      lines.push(`\nRecommendations (${slim.answerEnvelope.recommendations.length}):`);
      slim.answerEnvelope.recommendations.forEach((r, i) => {
        lines.push(`  ${i + 1}. [${r.horizon ?? "unscoped"}] ${r.action}`);
        lines.push(`     rationale: ${trimToLength(r.rationale, 400)}`);
      });
    }
    if (slim.answerEnvelope.methodology) {
      lines.push(`\nMethodology: ${trimToLength(slim.answerEnvelope.methodology, 1500)}`);
    }
    if (slim.answerEnvelope.caveats?.length) {
      lines.push(`Caveats: ${slim.answerEnvelope.caveats.slice(0, 6).join(" · ")}`);
    }
    if (slim.answerEnvelope.domainLens) {
      lines.push(`\nDomain lens: ${trimToLength(slim.answerEnvelope.domainLens, 800)}`);
    }
  }
  if (slim.businessActions?.length) {
    lines.push(`\n# BUSINESS ACTIONS (decisions to make in the world, distinct from analytical recommendations above)\n`);
    slim.businessActions.forEach((a, i) => {
      lines.push(`  ${i + 1}. [${a.horizon}/${a.confidence}] ${a.title}`);
      lines.push(`     rationale: ${trimToLength(a.rationale, 400)}`);
    });
  }
  lines.push(`\n# CHART INVENTORY (refer to charts by id; do NOT invent ids)\n`);
  for (const sheet of slim.sheets) {
    lines.push(`Sheet "${sheet.name}" (${sheet.charts.length} charts, ${sheet.tables.length} tables):`);
    for (const c of sheet.charts) {
      const cap = [c.x ? `x=${c.x}` : null, c.y ? `y=${c.y}` : null, c.seriesColumn ? `series=${c.seriesColumn}` : null]
        .filter(Boolean)
        .join(", ");
      lines.push(`  - ${c.id}: ${c.type} · "${c.title}"${cap ? ` (${cap})` : ""}`);
      if (c.insight) lines.push(`      insight: ${c.insight}`);
      if (c.businessCommentary) lines.push(`      commentary: ${c.businessCommentary}`);
    }
    for (const t of sheet.tables) {
      lines.push(`  - ${t.id}: table · "${t.caption}" (${t.columnCount} cols, ${t.rowCount} rows)`);
    }
    if (sheet.narrativeSummaries.length) {
      lines.push(`  Narrative blocks (${sheet.narrativeSummaries.length}):`);
      sheet.narrativeSummaries.forEach((n) => {
        lines.push(`    - [${n.role}] ${n.title}: ${trimToLength(n.body, 400)}`);
      });
    }
  }
  return lines.join("\n");
}

export function buildDeckPlannerUserPrompt(inputs: DeckPlannerInputs): string {
  const slim = buildSlimDashboard(inputs);
  // Wave B6 · Optional ambient-context blocks. Capped tight so the
  // prompt stays under the W-EXP-2 system+user budget. Each block is
  // labelled so the planner can disregard / honour it independently.
  const sections: string[] = [formatSlimDashboardForPrompt(slim)];

  if (inputs.permanentContext?.trim()) {
    const text = inputs.permanentContext.trim().slice(0, 800);
    sections.push(
      `\n# USER PREFERENCES (standing notes the user set on this session — honour for deck framing and exec-summary phrasing; do NOT invent figures from these notes):\n${text}`
    );
  }
  if (inputs.dimensionHierarchies?.length) {
    const lines = inputs.dimensionHierarchies.slice(0, 10).map((h) => {
      const children = h.itemValues?.length ? ` · children: ${h.itemValues.slice(0, 6).join(", ")}` : "";
      const desc = h.description ? ` — ${h.description}` : "";
      return `  - ${h.column}: "${h.rollupValue}" is a rollup row${children}${desc}`;
    });
    sections.push(
      `\n# DIMENSION HIERARCHIES (declared by the user — treat rollup values as category totals, NEVER as peers in deck slides; recommendations on these dimensions must be framed as "within the <rollupValue> category" not "vs <rollupValue>"):\n${lines.join("\n")}`
    );
  }
  if (inputs.wideFormatShape?.detected) {
    const w = inputs.wideFormatShape;
    const meltedNote = w.meltedColumns?.length
      ? `\n  Original wide column names (NO LONGER EXIST — never reference): ${w.meltedColumns.slice(0, 8).join(", ")}${w.meltedColumns.length > 8 ? ` (+${w.meltedColumns.length - 8} more)` : ""}`
      : "";
    sections.push(
      `\n# DATASET SHAPE (post-melt) — the underlying dataset arrived in WIDE format and was MELTED to LONG form at upload time:
  shape: ${w.shape ?? "unknown"}
  period column: ${w.periodColumn ?? "(none)"}
  periodIso column: ${w.periodIsoColumn ?? "(none)"}
  value column: ${w.valueColumn ?? "(none)"}${w.metricColumn ? `\n  metric column: ${w.metricColumn} (compound shape — SUM(value) is only meaningful when scoped by a Metric value)` : ""}${meltedNote}`
    );
  }

  sections.push(`\nCompose the SlideDeckPlan now. Remember:
- Every slide has an action title (verb + number, complete sentence — reading the titles tells the story).
- Pick layouts from the closed enum.
- Reference charts by their inventory id only.
- Methodology in the back third.
- Speaker notes ≥ 20 chars on every slide.
- Aim for 8–14 slides total; hard cap 16; floor 3.`);

  return sections.join("\n");
}

export interface DeckPlannerRepairContext {
  /** Issues surfaced by the deterministic verifier (W-EXP-3). */
  issues: string;
  /** The prior plan that failed verification — let the model fix in place. */
  priorPlan: SlideDeckPlan;
}

export interface DeckPlannerOptions {
  /** Test stub hook — present for parity with narrator pattern; no-op in prod. */
  onLlmCall?: () => void;
  /** Stable id for cost telemetry / cache eligibility. */
  turnId?: string;
}

/**
 * Run the deck-planner LLM call with optional repair branch. Returns null on
 * failure; the caller renders a deterministic fallback (W-EXP-7/11 will land
 * a "minimal deck" path that the controller falls back to so the user always
 * gets a download even when the planner errors).
 */
export async function runDeckPlanner(
  inputs: DeckPlannerInputs,
  opts: DeckPlannerOptions = {},
  repair?: DeckPlannerRepairContext
): Promise<SlideDeckPlan | null> {
  const userPrompt = buildDeckPlannerUserPrompt(inputs);

  // The repair branch appends a focused "fix these issues" block at the END
  // of the user message — keeping the dashboard description byte-identical
  // means the prompt cache still hits across the initial + repair calls.
  const repairBlock = repair
    ? `\n\nThe previous plan failed verification. Fix these issues:\n${repair.issues.slice(0, 1500)}\n\nPrior plan (rewrite to fix the issues, do not start over from scratch):\n${JSON.stringify(repair.priorPlan).slice(0, 6000)}`
    : "";

  const finalUser = `${userPrompt}${repairBlock}`;

  const result = await completeJson(DECK_PLANNER_SYSTEM, finalUser, slideDeckPlanSchema, {
    turnId: `${opts.turnId ?? "deck"}_planner${repair ? "_repair" : ""}`,
    // Generous — a 14-slide deck with rich speaker notes can run 6–8K tokens
    // of output. 12K leaves headroom without being so large it invites runaway.
    maxTokens: 12_000,
    temperature: 0.3,
    onLlmCall: opts.onLlmCall,
    purpose: LLM_PURPOSE.DECK_PLANNER,
  });

  if (!result.ok) {
    agentLog("deckPlanner.failed", {
      turnId: opts.turnId,
      error: result.error,
      repair: !!repair,
    });
    return null;
  }

  agentLog(repair ? "deckPlanner.repair" : "deckPlanner.done", {
    turnId: opts.turnId,
    slideCount: result.data.slides.length,
    repair: !!repair,
  });
  return result.data;
}
