/**
 * Wave A4 · Build an Automation payload from a captured chat session.
 *
 * Pure function. Takes a `ChatDocument` snapshot + capture metadata
 * and returns the body that `createAutomation` will persist.
 *
 * Contract:
 *  - Walks `chat.messages` in order, pairing each user message with the
 *    immediately-following assistant message (skipping intermediate
 *    `isIntermediate: true` rows). Each pair becomes one AutomationTurn.
 *  - Plan steps come from `assistant.agentTrace.steps[]` when present;
 *    fallback to empty list (the turn replays as "user message only" —
 *    rare but not catastrophic; live narrator will run).
 *  - Charts / pivotDefaults / dashboardDraft / createdDashboardName are
 *    snapshotted from the assistant message AS-IS.
 *  - `expectedSchema.rawColumns` is derived from `dataSummary` without
 *    needing any new instrumentation:
 *      • Wide-format: idColumns + meltedColumns from wideFormatTransform.
 *      • Non-wide: dataSummary.columns minus temporalFacetColumns.
 *  - `sessionTransformations.sessionComputedColumns` walks every turn for
 *    `add_computed_columns` plan steps with `persistToSession: true` and
 *    captures `{name, formula, sourceTurnOrdinal}` for upfront re-application.
 */

import type {
  Automation,
  AutomationColumnInfo,
  AutomationSessionComputedColumn,
  AutomationTurn,
  ChartSpec,
  DataSummary,
} from "../../shared/schema.js";
import type { z } from "zod";
import { pivotDefaultsSchema } from "../../shared/schema.js";

type PivotDefaults = z.infer<typeof pivotDefaultsSchema>;

interface MessageLite {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
  isIntermediate?: boolean;
  charts?: ChartSpec[];
  pivotDefaults?: PivotDefaults;
  dashboardDraft?: Record<string, unknown>;
  createdDashboardId?: string;
  agentTrace?: Record<string, unknown>;
}

interface ChatLite {
  id: string;
  username: string;
  fileName: string;
  messages: MessageLite[];
  dataSummary?: DataSummary;
  permanentContext?: string;
  sessionAnalysisContext?: Record<string, unknown>;
  sessionId?: string;
}

interface BuildRecipeOptions {
  name: string;
  description?: string;
}

interface BuildRecipeResult {
  /** The full Automation body, minus fields the model fills in (id, createdAt, runCount, lastRunAt). */
  draft: Omit<Automation, "id" | "createdAt" | "runCount" | "lastRunAt">;
  /** Diagnostic counters useful for the response payload + tests. */
  stats: {
    capturedTurns: number;
    skippedIntermediates: number;
    chartCount: number;
    dashboardCount: number;
    sessionComputedColumnCount: number;
  };
}

const STEPS_KEY = "steps";

const isPlanStepArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) &&
  value.every((v) => v && typeof v === "object" && !Array.isArray(v));

const extractPlanSteps = (
  agentTrace: Record<string, unknown> | undefined
): Record<string, unknown>[] => {
  if (!agentTrace) return [];
  const steps = agentTrace[STEPS_KEY];
  if (!isPlanStepArray(steps)) return [];
  // Cap at the schema max (60) to avoid round-trip rejection.
  return steps.slice(0, 60);
};

/**
 * Derive the original raw column list from a post-upload `dataSummary`
 * without needing any new instrumentation.
 */
export const deriveRawColumnsFromDataSummary = (
  summary: DataSummary | undefined
): AutomationColumnInfo[] => {
  if (!summary) return [];
  const wf = summary.wideFormatTransform;
  if (wf?.detected) {
    const idCols: AutomationColumnInfo[] = wf.idColumns.map((name) => ({
      name,
      type: "string",
    }));
    const meltedCols: AutomationColumnInfo[] = wf.meltedColumns.map((name) => ({
      name,
      type: "number",
    }));
    return [...idCols, ...meltedCols];
  }
  const facetNames = new Set(
    (summary.temporalFacetColumns ?? []).map((f) => f.name)
  );
  return summary.columns
    .filter((c) => !facetNames.has(c.name))
    .map((c) => ({
      name: c.name,
      type: c.type,
      sampleValues: c.sampleValues?.slice(0, 6),
      topValues: c.topValues?.slice(0, 6),
    }));
};

const toFinalColumnInfo = (
  summary: DataSummary | undefined
): AutomationColumnInfo[] => {
  if (!summary) return [];
  return summary.columns.map((c) => ({
    name: c.name,
    type: c.type,
    sampleValues: c.sampleValues?.slice(0, 6),
    topValues: c.topValues?.slice(0, 6),
  }));
};

const collectSessionComputedColumns = (
  turns: AutomationTurn[]
): AutomationSessionComputedColumn[] => {
  const captured: AutomationSessionComputedColumn[] = [];
  for (const turn of turns) {
    for (const step of turn.planSteps) {
      const tool = (step as Record<string, unknown>).tool;
      const args = (step as Record<string, unknown>).args as
        | Record<string, unknown>
        | undefined;
      if (tool !== "add_computed_columns" || !args) continue;
      if (args.persistToSession !== true) continue;
      const cols = args.columns;
      if (!Array.isArray(cols)) continue;
      for (const c of cols) {
        if (!c || typeof c !== "object") continue;
        const name = (c as Record<string, unknown>).name;
        const formula =
          (c as Record<string, unknown>).formula ??
          (c as Record<string, unknown>).expression;
        if (typeof name !== "string" || !name.trim()) continue;
        if (typeof formula !== "string" || !formula.trim()) continue;
        captured.push({
          name: name.trim(),
          formula: formula.trim(),
          sourceTurnOrdinal: turn.ordinal,
        });
      }
    }
  }
  return captured.slice(0, 40);
};

export const buildRecipeFromChat = (
  chat: ChatLite,
  opts: BuildRecipeOptions
): BuildRecipeResult => {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const turns: AutomationTurn[] = [];
  let chartCount = 0;
  let dashboardCount = 0;
  let skippedIntermediates = 0;
  let pendingUserQuestion: string | null = null;

  let ordinal = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      pendingUserQuestion = msg.content?.trim() || null;
      continue;
    }
    // assistant
    if (msg.isIntermediate) {
      skippedIntermediates += 1;
      continue;
    }
    if (!pendingUserQuestion) {
      // Rare: orphan assistant (e.g. system upload preamble) — skip.
      continue;
    }
    const planSteps = extractPlanSteps(msg.agentTrace);
    const charts = (msg.charts ?? []).slice(0, 24);
    chartCount += charts.length;
    if (msg.createdDashboardId || msg.dashboardDraft) dashboardCount += 1;

    const turn: AutomationTurn = {
      ordinal,
      question: pendingUserQuestion.slice(0, 8000),
      planSteps,
      charts: charts.length > 0 ? charts : undefined,
      pivotDefaults: msg.pivotDefaults,
      dashboardDraft: msg.dashboardDraft as AutomationTurn["dashboardDraft"],
      createdDashboardName: undefined, // filled in below if we can resolve it
    };
    turns.push(turn);
    ordinal += 1;
    pendingUserQuestion = null;
  }

  const sessionComputedColumns = collectSessionComputedColumns(turns);
  const rawColumns = deriveRawColumnsFromDataSummary(chat.dataSummary);
  const finalColumns = toFinalColumnInfo(chat.dataSummary);

  const draft: Omit<
    Automation,
    "id" | "createdAt" | "runCount" | "lastRunAt"
  > = {
    username: chat.username,
    name: opts.name.trim(),
    description: opts.description?.trim(),
    sourceSessionId: chat.sessionId ?? chat.id,
    sourceFileName: chat.fileName,
    expectedSchema: {
      rawColumns,
      finalColumns,
    },
    sessionTransformations: {
      wideFormatTransform: chat.dataSummary?.wideFormatTransform,
      sessionComputedColumns:
        sessionComputedColumns.length > 0 ? sessionComputedColumns : undefined,
      permanentContext: chat.permanentContext,
      seedSessionAnalysisContext: chat.sessionAnalysisContext as
        | Record<string, never>
        | undefined,
    },
    recipe: turns,
  };

  return {
    draft,
    stats: {
      capturedTurns: turns.length,
      skippedIntermediates,
      chartCount,
      dashboardCount,
      sessionComputedColumnCount: sessionComputedColumns.length,
    },
  };
};
