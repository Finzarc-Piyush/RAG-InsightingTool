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
  type AnswerMagnitude,
  type ChartSpec,
  type DashboardSpec,
} from "../../../shared/schema.js";
import type { AnalysisBrief as _ } from "../../../shared/schema.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { agentLog } from "./agentLogger.js";
import { applyDashboardTemplateLayout } from "./dashboardTemplates.js";

/** Magnitudes live on AgentLoopResult; re-declared here so this module stays framework-agnostic. */
type MagnitudeLike = AnswerMagnitude;

export interface BuildDashboardArgs {
  question: string;
  answerBody: string;
  keyInsight?: string;
  charts: ChartSpec[];
  magnitudes?: MagnitudeLike[];
  brief?: AnalysisBrief;
  turnId: string;
  onLlmCall: () => void;
}

// W7.6 · Pure-logic gating moved to ./dashboardAutogenGate.ts so it can be
// unit-tested without loading the openai module. Re-exported here for
// backward compatibility with the existing call sites.
export {
  isDashboardAutogenEnabled,
  dashboardAutogenRolloutPct,
  isUserEnrolledInDashboardAutogenRollout,
  shouldBuildDashboard,
} from "./dashboardAutogenGate.js";

/**
 * Produce a DashboardSpec from the current turn's artifacts. Never throws —
 * a failure returns null and the agent loop treats that as "no draft emitted".
 */
export async function buildDashboardFromTurn(
  args: BuildDashboardArgs
): Promise<DashboardSpec | null> {
  const system = `You design a two-sheet dashboard from an analysis turn.
Output JSON only matching the provided schema with fields:
- name: a concise dashboard title derived from the user question (max 200 chars).
- template: pick "executive" for high-level summaries, "deep_dive" for diagnostic
  answers with multiple charts, "monitoring" for KPI / metric-strip views.
- sheets: exactly TWO sheets in this order —
  Sheet 1 id="sheet_summary", name="Summary". Put narrativeBlocks here with:
    - role "summary": 2–4 sentences of the assistant's main answer.
    - optionally role "recommendations": 1–3 concrete next steps if they follow
      from the answer; leave out otherwise.
    - optionally role "limitations": 1 sentence on what the data could not show
      (use "unexplained" note if provided).
    - role "custom" title "Original question": include the user question verbatim.
  Sheet 2 id="sheet_evidence", name="Evidence". Include every chart from the
    "Provided charts" list, in the same order. Do NOT invent charts; do not
    drop charts (the server expects all of them).
- defaultSheetId: "sheet_summary".
- question: the verbatim user question (truncate to 4000 chars).
Narrative body strings must come from the assistant's answer + magnitudes; do
NOT invent numbers. Keep each narrativeBlock.body under 1500 chars.`;

  const magnitudesBlock = args.magnitudes?.length
    ? `\n\nMagnitudes supporting the answer:\n${args.magnitudes
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
  const chartsBlock = `\n\nProvided charts (use each one on the Evidence sheet, in order):\n${args.charts
    .map((c, i) => `- #${i + 1}: type=${c.type}, title=${c.title ?? "(untitled)"}`)
    .join("\n")}`;

  const user = `User question:\n${args.question.slice(0, 3000)}\n\nAssistant answer body:\n${args.answerBody.slice(0, 6000)}${insightBlock}${magnitudesBlock}${chartsBlock}`;

  try {
    const out = await completeJson(system, user, dashboardSpecSchema, {
      turnId: `${args.turnId}_dashdraft`,
      temperature: 0.2,
      maxTokens: 2200,
      onLlmCall: args.onLlmCall,
      purpose: LLM_PURPOSE.BUILD_DASHBOARD,
    });
    if (!out.ok) {
      agentLog("buildDashboard.parse_failed", {
        turnId: args.turnId,
        error: out.error.slice(0, 400),
      });
      return null;
    }

    // Ensure every chart from the turn lands on the Evidence sheet. The LLM
    // is asked to emit them but we substitute the authoritative ChartSpec
    // objects to avoid drift (titles shift, data-binding hints are lost, etc.).
    const spec = out.data;
    const evidenceIdx = spec.sheets.findIndex(
      (s) => s.id === "sheet_evidence" || s.name.toLowerCase() === "evidence"
    );
    if (evidenceIdx >= 0) {
      const evidence = spec.sheets[evidenceIdx];
      spec.sheets[evidenceIdx] = {
        ...evidence,
        charts: [...args.charts],
      };
    } else {
      // Defensive: LLM dropped the evidence sheet — append one.
      spec.sheets.push({
        id: "sheet_evidence",
        name: "Evidence",
        charts: [...args.charts],
      });
    }

    // Assign stable narrative-block ids if the LLM forgot them.
    for (const sheet of spec.sheets) {
      if (Array.isArray(sheet.narrativeBlocks)) {
        sheet.narrativeBlocks = sheet.narrativeBlocks.map((b) => ({
          ...b,
          id: b.id && b.id.length > 0 ? b.id : randomUUID(),
        }));
      }
    }

    // Guarantee a defaultSheetId pointing at an existing sheet.
    if (
      !spec.defaultSheetId ||
      !spec.sheets.some((s) => s.id === spec.defaultSheetId)
    ) {
      spec.defaultSheetId = spec.sheets[0]?.id;
    }

    // Apply a deterministic gridLayout based on the chosen template so the
    // first render isn't a stack of equally-sized tiles.
    applyDashboardTemplateLayout(spec);

    return spec;
  } catch (err) {
    agentLog("buildDashboard.threw", {
      turnId: args.turnId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
