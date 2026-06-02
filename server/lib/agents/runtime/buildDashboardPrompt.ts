/**
 * ============================================================================
 * buildDashboardPrompt.ts — writes the prompts that ask the LLM for a dashboard
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the agent auto-generates a dashboard from a finished analysis, it asks
 *   an LLM to write the narrative (titles, key conclusion, recommendations,
 *   limitations) for a fixed two-sheet layout. This file holds the pure string
 *   builders for that LLM call: a constant SYSTEM prompt describing the exact
 *   two-sheet contract, and a USER prompt that packs in everything the LLM should
 *   draw from — the question, the answer body, the structured AnswerEnvelope
 *   (TL;DR, findings, implications, recommendations, caveats, domain lens),
 *   magnitudes, the user's pivot snapshot, intermediate step findings, and the
 *   list of provided charts.
 *
 * WHY IT MATTERS
 *   The two-sheet contract is strict on purpose: the LLM writes ONLY narrative
 *   for Sheet 1 and a bare shell for Sheet 2 — the server places all charts,
 *   pivots, and ledger blocks deterministically (see dashboardTemplates.ts). The
 *   user prompt repeatedly instructs "use verbatim, never invent figures, cite
 *   these exact chart titles" so the dashboard stays anchored to real, decision-
 *   grade content the agent already produced rather than re-summarising loosely.
 *
 * KEY PIECES
 *   - DASHBOARD_SYSTEM_PROMPT / buildDashboardSystemPrompt — the fixed contract.
 *   - buildDashboardUserPrompt — assembles the per-turn user prompt from
 *     BuildDashboardPromptArgs, slicing each section to stay within length caps.
 *
 * HOW IT CONNECTS
 *   Reads types from shared/schema.js (AnalysisBrief, ChartSpec,
 *   DashboardAnswerEnvelope). Extracted from buildDashboard.ts (the runtime that
 *   actually makes the LLM call and assembles sheets) so these builders can be
 *   unit-tested without importing the OpenAI client (which demands Azure env vars
 *   at import time). MUST stay free of side-effecting imports — types + string
 *   assembly only, no completeJson, no agentLog.
 */
import type {
  AnalysisBrief,
  ChartSpec,
  DashboardAnswerEnvelope,
} from "../../../shared/schema.js";

// Inline shape matches messageSchema.magnitudes in shared/schema.ts. Keeping it
// inline avoids re-exporting a Zod-derived type just for this prompt builder.
type MagnitudeLike = {
  label: string;
  value: string;
  confidence?: "low" | "medium" | "high";
};

export interface BuildDashboardPromptArgs {
  question: string;
  answerBody: string;
  keyInsight?: string;
  charts: ChartSpec[];
  magnitudes?: MagnitudeLike[];
  brief?: AnalysisBrief;
  intermediateSummaries?: string[];
  /**
   * Slim AnswerEnvelope distilled by the narrator. When present the
   * dashboard LLM must prefer these structured findings/recommendations
   * verbatim over re-summarising from `answerBody` — preserves the
   * decision-grade content the agent already produced.
   */
  envelope?: DashboardAnswerEnvelope;
  /**
   * The user's frozen pivot snapshot (rows/columns/values/agg) for this
   * turn, lifted onto Sheet 1 (`useExecPivot=true`) and Sheet 2 (always)
   * by the buildDashboard runtime. Surfaced in the prompt so the LLM can
   * choose to cite it in the Summary narrative.
   */
  pivotSummary?: string;
}

export const DASHBOARD_SYSTEM_PROMPT = `You design a two-sheet dashboard from an analysis turn.

Sheet 1 ("Executive Summary") is a SHORT, decision-grade STORY: the key
conclusion plus grouped recommendations and the methodology. The server adds
the most important charts and the pivot deterministically — you only emit
the narrative.

Sheet 2 ("All Artefacts") is the raw ledger — the server will populate it
deterministically with every chart, the pivot, and step-insight narrative
blocks. Emit it as a bare sheet shell (just id + name); the server overwrites
its charts, pivots, and narrativeBlocks.

Output JSON only matching the provided schema with these fields:
- name: a concise dashboard title derived from the user question (max 200 chars).
- template: "executive" for high-level summaries, "deep_dive" for diagnostic
  answers, "monitoring" for KPI strips.
- sheets: exactly TWO sheets in this order:

  Sheet 1: id="sheet_summary", name="Executive Summary".
    DO NOT emit \`charts\` or \`pivots\` — the server populates them.
    Populate narrativeBlocks ONLY:
    - role "summary", title "Key conclusion": 2–4 sentences. When TL;DR is
      supplied, USE IT VERBATIM as the first line, then expand with 1–3
      sentences that NAME the most important chart/pivot titles being cited.
      Numbers must come from the supplied envelope / magnitudes / tool
      summaries — NEVER invent figures. This block reads as one continuous
      argument; reference these EXACT titles from the "Provided charts" list
      so the prose stays anchored to the visuals.
    - When the input "Recommendations" block is non-empty, role
      "recommendations", title "Recommendations": one bullet per
      recommendation, USE THE ACTION + RATIONALE TEXT VERBATIM, prefixed by
      horizon ("Now / This quarter / Strategic"). Each bullet MUST cite either a chart title or a magnitude as its evidence. MANDATORY when
      recommendations are provided.
    - When "Caveats / limitations" are supplied, role "limitations",
      title "Limitations": bullets verbatim from those caveats.

    Do NOT emit narrative blocks titled "Methodology", "How to read this
    dashboard", or "Original question". The chart titles and the answer
    envelope already convey purpose and approach; these tiles add no
    analytical value and will be stripped if present.

  Sheet 2: id="sheet_all", name="All Artefacts".
    Emit ONLY the sheet shell: \`{"id":"sheet_all","name":"All Artefacts"}\`.
    Do NOT include charts, pivots, or narrativeBlocks — the server fills
    them in deterministically. Do not invent any of these fields.

- defaultSheetId: "sheet_summary".
- question: the verbatim user question (truncate to 4000 chars).
Keep each narrativeBlock.body under 1500 chars.`;

export function buildDashboardSystemPrompt(): string {
  return DASHBOARD_SYSTEM_PROMPT;
}

export function buildDashboardUserPrompt(args: BuildDashboardPromptArgs): string {
  const env = args.envelope;
  const tldrBlock = env?.tldr ? `\n\nTL;DR (use VERBATIM as the Key conclusion):\n${env.tldr}` : "";
  const findingsBlock = env?.findings?.length
    ? `\n\nStructured findings (cite each headline + magnitude verbatim where it lines up with a chart):\n${env.findings
        .slice(0, 5)
        .map(
          (f, i) =>
            `- #${i + 1} ${f.headline}${f.magnitude ? ` [${f.magnitude}]` : ""}\n  evidence: ${f.evidence}`
        )
        .join("\n")}`
    : "";
  const implicationsBlock = env?.implications?.length
    ? `\n\nImplications (statement → soWhat, with confidence):\n${env.implications
        .slice(0, 4)
        .map(
          (im, i) =>
            `- #${i + 1}: ${im.statement} → ${im.soWhat}${im.confidence ? ` (${im.confidence})` : ""}`
        )
        .join("\n")}`
    : "";
  const recommendationsBlock = env?.recommendations?.length
    ? `\n\nRecommendations (use VERBATIM in the recommendations narrative block, grouped by horizon):\n${env.recommendations
        .slice(0, 4)
        .map(
          (r, i) =>
            `- #${i + 1} [${r.horizon ?? "now"}] ${r.action} — ${r.rationale}`
        )
        .join("\n")}`
    : "";
  const caveatsBlock = env?.caveats?.length
    ? `\n\nCaveats / limitations:\n${env.caveats.slice(0, 3).map((c) => `- ${c}`).join("\n")}`
    : "";
  const domainLensBlock = env?.domainLens
    ? `\n\nDomain lens (FMCG/Marico framing — cite when relevant):\n${env.domainLens}`
    : "";
  const envelopeMagnitudes = env?.magnitudes ?? args.magnitudes;
  const magnitudesBlock = envelopeMagnitudes?.length
    ? `\n\nMagnitudes supporting the answer:\n${envelopeMagnitudes
        .slice(0, 6)
        .map(
          (m) =>
            `- ${m.label}: ${m.value}${m.confidence ? ` (confidence: ${m.confidence})` : ""}`
        )
        .join("\n")}`
    : "";
  const insightBlock = args.keyInsight
    ? `\n\nKey insight:\n${args.keyInsight.slice(0, 800)}`
    : "";
  const pivotBlock = args.pivotSummary
    ? `\n\nUser's pivot snapshot (will be lifted onto BOTH sheets — refer to it as "the pivot" in the Summary narrative):\n${args.pivotSummary.slice(0, 600)}`
    : "";
  const chartsBlock = `\n\nProvided charts (use each one on the All Artefacts sheet, in order; reference these EXACT titles in the Executive Summary narrative):\n${args.charts
    .map((c, i) => `- #${i + 1}: type=${c.type}, title=${c.title ?? "(untitled)"}`)
    .join("\n")}`;
  const intermediateBlock = args.intermediateSummaries?.length
    ? `\n\nIntermediate analytical findings from this turn's tool calls (cite these in the Summary narrative — they are the chain of reasoning that produced each chart):\n${args.intermediateSummaries
        .slice(0, 8)
        .map((s, i) => `- step ${i + 1}: ${s.slice(0, 600)}`)
        .join("\n")}`
    : "";
  return `User question:\n${args.question.slice(0, 3000)}\n\nAssistant answer body:\n${args.answerBody.slice(0, 6000)}${tldrBlock}${findingsBlock}${implicationsBlock}${recommendationsBlock}${caveatsBlock}${domainLensBlock}${insightBlock}${magnitudesBlock}${pivotBlock}${intermediateBlock}${chartsBlock}`;
}
