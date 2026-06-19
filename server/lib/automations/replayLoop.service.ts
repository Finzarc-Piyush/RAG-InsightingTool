/**
 * Wave A8 (v2) · Automation replay loop — deterministic execution.
 *
 * Single entry: `replayAutomation` — given a target `sessionId`, an
 * `automationId`, and a user-confirmed `columnMapping`, walks the saved
 * recipe turn by turn, dispatching each saved plan step through the
 * existing `ToolRegistry` against the new session, then runs the live
 * narrator to produce decision-grade answer text against new numbers.
 * Emits SSE progress events the client renders in
 * `AutomationReplayBanner`.
 *
 * Stages:
 *   1. Load the automation + new chat doc, validate ownership.
 *   2. Validate the column mapping covers every saved column.
 *   3. Apply the mapping → live recipe (deep-cloned, never mutates input).
 *   4. Plan + apply session transformations (permanentContext, etc.).
 *   5. Build a single AgentExecutionContext for the new session.
 *   6. For each AutomationTurn:
 *        a. Persist the user message.
 *        b. Emit `automation_progress {phase: "replaying_turn", ordinal, total}`.
 *        c. Reset blackboard, set ctx.question.
 *        d. For each plan step: dispatch via ToolRegistry; on failure
 *           halt with rich diagnostic.
 *        e. Run narrator against the new blackboard → live answer text +
 *           AnswerEnvelope.
 *        f. Persist assistant message with `replayedFromAutomationId`.
 *   7. Halt cleanly on first error; success emits `automation_complete`.
 *
 * Determinism: planner is bypassed (saved steps used directly). The
 * narrator runs live — its output reflects the new dataset's numbers.
 * This is the "deterministic recipe; live narrative" convention.
 */

import {
  addMessageToChat,
  getChatDocument,
  mutateChatDocument,
  updateSessionPermanentContext,
} from "../../models/chat.model.js";
import {
  getAutomationById,
  touchAutomationLastRun,
} from "../../models/automation.model.js";
import { applyColumnMappingToRecipe } from "./applyColumnMapping.js";
import { planSessionTransformations } from "./planSessionTransformations.js";
import { loadLatestData } from "../../utils/dataLoader.js";
import { buildAgentExecutionContext } from "../agents/runtime/context.js";
import { loadAgentConfigFromEnv } from "../agents/runtime/runtimeConfig.js";
import type { AgentExecutionContext } from "../agents/runtime/types.js";
import { ToolRegistry } from "../agents/runtime/toolRegistry.js";
import { registerDefaultTools } from "../agents/runtime/tools/registerTools.js";
import {
  createBlackboard,
  addFinding,
} from "../agents/runtime/analyticalBlackboard.js";
import { runNarrator } from "../agents/runtime/narratorAgent.js";
import { runBusinessActions } from "../agents/runtime/businessActionsAgent.js";
import { isBusinessActionsEnabled } from "../envFlags.js";
import { planStepSchema } from "../agents/runtime/schemas.js";
import { loadEnabledDomainContext } from "../domainContext/loadEnabledDomainContext.js";
import { applyWideFormatMeltIfNeeded } from "../wideFormat/applyWideFormatMeltIfNeeded.js";
import { applyWideFormatTransformToSummary } from "../wideFormat/applyWideFormatToSummary.js";
import { saveModifiedData } from "../dataOps/dataPersistence.js";
import { createDataSummary } from "../fileParser.js";
import type {
  Automation,
  AutomationColumnInfo,
  AutomationColumnMapping,
  AutomationTurn,
  ChartSpec,
  Insight,
  Message,
} from "../../shared/schema.js";
import { chartIdentityKey } from "../../shared/schema.js";
import type { ChatDocument } from "../../models/chat.model.js";
import { logger } from "../logger.js";
import { errorMessage } from "../../utils/errorMessage.js";

export type ReplaySseEvent =
  | { type: "automation_started"; automationId: string; recipeLength: number }
  | {
      type: "automation_progress";
      phase: "preparing_dataset" | "replaying_turn";
      step: number;
      total: number;
      detail?: string;
    }
  | {
      type: "automation_halted";
      ordinal: number;
      stepId?: string;
      error: string;
    }
  | {
      type: "automation_complete";
      questionsReplayed: number;
      dashboardsCreated: number;
    };

export type ReplaySseEmit = (event: ReplaySseEvent) => void;

export interface ReplayAutomationArgs {
  sessionId: string;
  automationId: string;
  username: string;
  columnMapping?: AutomationColumnMapping;
  /** Optional ordinal to resume from (skip earlier turns). Used by the
   *  client's "Skip this question and continue" recovery path. */
  resumeFromOrdinal?: number;
  emit: ReplaySseEmit;
  /** Aborted when the SSE client disconnects. The replay loop checks
   *  between turns and exits cleanly so we don't burn LLM budget after
   *  the user has closed the browser tab. */
  abortSignal?: AbortSignal;
}

export interface ReplayAutomationResult {
  ok: boolean;
  questionsReplayed: number;
  dashboardsCreated: number;
  haltedAtOrdinal?: number;
  error?: string;
}

/**
 * Wave WR1 · the in-memory recipe the extracted `replayRecipe` consumes —
 * exactly the fields `buildRecipeFromChat` produces and a persisted
 * `Automation` carries. Lets one replay core target either a saved automation
 * (replayed onto a NEW session) OR an in-place data refresh (the SAME session).
 */
export interface RecipeSource {
  recipe: AutomationTurn[];
  expectedSchema: Automation["expectedSchema"];
  sessionTransformations: Automation["sessionTransformations"];
  name: string;
  /** Stamped onto turnIds + the `replayedFromAutomationId` provenance badge.
   *  Automation → its id; refresh → a synthetic `refresh_<sessionId>_<ts>`. */
  sourceId: string;
}

export interface ReplayRecipeArgs {
  sessionId: string;
  source: RecipeSource;
  username: string;
  columnMapping?: AutomationColumnMapping;
  /** Optional ordinal to resume from (skip earlier turns). */
  resumeFromOrdinal?: number;
  /**
   * `append-messages` (automation → new session) appends each turn's
   * user+assistant message as it replays. `overwrite` (in-place refresh)
   * snapshots the prior conversation into `messageVersions`, truncates the
   * chat to its welcome prefix, then appends the regenerated turns — so the
   * refreshed chat reflects ONLY the new data, with the prior kept for rollback.
   */
  mode: "append-messages" | "overwrite";
  emit: ReplaySseEmit;
  abortSignal?: AbortSignal;
}

const findUnresolvedColumns = (
  finalColumns: AutomationColumnInfo[],
  mapping: AutomationColumnMapping,
  newColumnNames: Set<string>
): string[] => {
  const unresolved: string[] = [];
  for (const col of finalColumns) {
    const mapped = mapping[col.name];
    if (typeof mapped === "string" && mapped.length > 0) {
      if (!newColumnNames.has(mapped)) unresolved.push(col.name);
      continue;
    }
    if (!newColumnNames.has(col.name)) unresolved.push(col.name);
  }
  return unresolved;
};

/** Validate one captured plan step against the runtime planStepSchema.
 *  Returns null on failure — the caller decides whether to halt. */
const validatePlanStep = (
  raw: Record<string, unknown>
): { id: string; tool: string; args: Record<string, unknown> } | null => {
  const parsed = planStepSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    id: parsed.data.id,
    tool: parsed.data.tool,
    args: parsed.data.args,
  };
};

/**
 * Wave WR5 · Rebind a saved dashboard draft's chart entries to the freshly
 * emitted tool charts so the dashboard renders the NEW data, not the captured
 * session's stale numbers.
 *
 * Matches by the axis-aware `chartIdentityKey` (`type::title::x::y::series`),
 * NOT by title alone. Two charts that share a title but differ in breakdown —
 * e.g. "Adherence Rate" by Cluster vs by ASM — get DISTINCT keys, so each
 * rebinds to its OWN fresh data instead of one stealing the other's (the L-010
 * trap; this is the load-bearing fix of WR5). A title fallback still applies,
 * but ONLY when the title is UNIQUE among the fresh charts — never on a
 * collision, which is exactly the case the identity key exists to disambiguate.
 *
 * Pure + exported for tests. Returns the draft unchanged when there's nothing
 * to rebind.
 */
export const rebindDashboardDraftCharts = (
  draft: Message["dashboardDraft"],
  finalCharts: ChartSpec[] | undefined
): Message["dashboardDraft"] => {
  if (!draft || !finalCharts || finalCharts.length === 0) return draft;

  const byKey = new Map<string, ChartSpec>();
  const titleCounts = new Map<string, number>();
  for (const c of finalCharts) {
    byKey.set(chartIdentityKey(c), c);
    if (typeof c.title === "string") {
      titleCounts.set(c.title, (titleCounts.get(c.title) ?? 0) + 1);
    }
  }
  const byUniqueTitle = new Map<string, ChartSpec>();
  for (const c of finalCharts) {
    if (typeof c.title === "string" && titleCounts.get(c.title) === 1) {
      byUniqueTitle.set(c.title, c);
    }
  }

  const pickLive = (chart: Record<string, unknown>): ChartSpec | undefined => {
    const keyed = byKey.get(
      chartIdentityKey(chart as Pick<ChartSpec, "type" | "title"> & {
        x?: string | null;
        y?: string | null;
        seriesColumn?: string | null;
      })
    );
    if (keyed) return keyed;
    // Safe fallback: title match ONLY when unambiguous among the fresh charts.
    return typeof chart.title === "string"
      ? byUniqueTitle.get(chart.title)
      : undefined;
  };

  const rebindChartList = (charts: Array<Record<string, unknown>>) =>
    charts.map((chart) => {
      const live = pickLive(chart);
      return live ? { ...chart, data: live.data } : chart;
    });

  const draftAny = draft as Record<string, unknown>;
  const rebound: Record<string, unknown> = { ...draftAny };
  if (Array.isArray(draftAny.charts)) {
    rebound.charts = rebindChartList(draftAny.charts as Array<Record<string, unknown>>);
  }
  if (Array.isArray(draftAny.sheets)) {
    rebound.sheets = (draftAny.sheets as Array<Record<string, unknown>>).map(
      (sheet) => {
        if (!Array.isArray(sheet.charts)) return sheet;
        return {
          ...sheet,
          charts: rebindChartList(sheet.charts as Array<Record<string, unknown>>),
        };
      }
    );
  }
  return rebound as Message["dashboardDraft"];
};

/** Build a one-line label for a finding from a tool's args. */
const labelFromArgs = (tool: string, args: Record<string, unknown>): string => {
  const parts: string[] = [tool];
  const groupBy = (args.groupBy ?? (args.plan as Record<string, unknown> | undefined)?.groupBy) as
    | unknown
    | undefined;
  if (Array.isArray(groupBy) && groupBy.length > 0) {
    parts.push(`by ${groupBy.slice(0, 3).join(", ")}`);
  }
  const breakdown = args.breakdownColumn;
  if (typeof breakdown === "string" && breakdown.length > 0) {
    parts.push(`breakdown=${breakdown}`);
  }
  return parts.join(" · ").slice(0, 120);
};

/**
 * Run one replayed turn end-to-end against the supplied AgentExecutionContext.
 *
 * Resets the blackboard + question, dispatches each plan step, accumulates
 * charts/insights, runs the narrator, and returns the assistant Message
 * payload ready to be persisted by the outer loop.
 *
 * Throws `ReplayStepError` on any step failure so the outer loop's
 * try/catch surfaces a clean halt SSE event with diagnostics.
 */
class ReplayStepError extends Error {
  readonly stepId: string | undefined;
  constructor(message: string, opts: { stepId?: string } = {}) {
    super(message);
    this.name = "ReplayStepError";
    this.stepId = opts.stepId;
  }
}

/** @internal exported for tests; invoke `replayAutomation` for production use. */
export const __executeReplayTurnForTest = (args: {
  ctx: AgentExecutionContext;
  registry: ToolRegistry;
  turn: AutomationTurn;
  automationId: string;
  turnId: string;
}) => executeReplayTurn(args);

const executeReplayTurn = async (args: {
  ctx: AgentExecutionContext;
  registry: ToolRegistry;
  turn: AutomationTurn;
  automationId: string;
  turnId: string;
}): Promise<{ assistantMessage: Message; dashboardCreated: boolean }> => {
  const { ctx, registry, turn, automationId, turnId } = args;
  const config = loadAgentConfigFromEnv();

  // Fresh per-turn blackboard. Lets the narrator see only this turn's
  // findings (matches live agent loop semantics).
  ctx.blackboard = createBlackboard();
  ctx.question = turn.question;

  const charts: ChartSpec[] = [];
  const insights: Insight[] = [];
  const structuredObservations: Array<{
    stepId: string;
    tool: string;
    args: Record<string, unknown>;
    metrics: {
      inputRowCount?: number;
      outputRowCount?: number;
      appliedAggregation?: boolean;
      durationMs?: number;
    };
  }> = [];

  // Sequential dispatch. Saved recipes captured before parallelGroup
  // support land here as sequential too — preserves correctness at the
  // cost of marginal speed; the deterministic guarantee is what matters.
  for (const rawStep of turn.planSteps) {
    const step = validatePlanStep(rawStep as Record<string, unknown>);
    if (!step) {
      throw new ReplayStepError(
        `Saved plan step is malformed (cannot validate against runtime schema). Tool: ${
          (rawStep as { tool?: string })?.tool ?? "?"
        }`,
        { stepId: (rawStep as { id?: string })?.id }
      );
    }

    const startedAt = Date.now();
    const result = await registry.execute(step.tool, step.args, {
      exec: ctx,
      config,
      turnId,
    });
    const durationMs = Date.now() - startedAt;

    if (!result.ok) {
      throw new ReplayStepError(
        `Tool "${step.tool}" failed: ${result.summary?.slice(0, 400) ?? "no summary"}`,
        { stepId: step.id }
      );
    }

    // Bridge tool result → blackboard (mirrors agentLoop.service.ts:2360).
    addFinding(ctx.blackboard!, {
      sourceRef: step.id,
      label: labelFromArgs(step.tool, step.args),
      detail: (result.summary ?? "").slice(0, 800),
      significance: "notable", // replayed steps come from a curated recipe; treat each as material
      relatedColumns: result.suggestedColumns ?? [],
    });

    if (Array.isArray(result.charts)) charts.push(...result.charts);
    if (Array.isArray(result.insights)) insights.push(...result.insights);

    structuredObservations.push({
      stepId: step.id,
      tool: step.tool,
      args: step.args,
      metrics: {
        inputRowCount: result.analyticalMeta?.inputRowCount,
        outputRowCount: result.analyticalMeta?.outputRowCount,
        appliedAggregation: result.analyticalMeta?.appliedAggregation,
        durationMs,
      },
    });
  }

  // Live narrator against the new findings. May return null when the
  // blackboard is empty — that means the saved steps produced nothing
  // tool-level (rare but possible if e.g. a pure clarify step was the
  // only thing in the recipe).
  let narratorBody = "";
  let answerEnvelope: Message["answerEnvelope"] | undefined;
  try {
    const narratorOutput = await runNarrator(
      ctx,
      ctx.blackboard!,
      turnId,
      () => {
        /* no LLM-call telemetry hook in replay v2 */
      },
      undefined,
      undefined,
      structuredObservations
    );
    if (narratorOutput) {
      narratorBody = narratorOutput.body ?? "";
      // NarratorOutput is flat; pick the AnswerEnvelope-shaped fields.
      const env: NonNullable<Message["answerEnvelope"]> = {};
      if (narratorOutput.tldr) env.tldr = narratorOutput.tldr;
      if (narratorOutput.findings) env.findings = narratorOutput.findings;
      if (narratorOutput.methodology)
        env.methodology = narratorOutput.methodology;
      if (narratorOutput.caveats) env.caveats = narratorOutput.caveats;
      if (narratorOutput.implications)
        env.implications = narratorOutput.implications;
      if (narratorOutput.recommendations)
        env.recommendations = narratorOutput.recommendations;
      if (narratorOutput.domainLens)
        env.domainLens = narratorOutput.domainLens;
      if (Object.keys(env).length > 0) answerEnvelope = env;
    }
  } catch (err) {
    // Narrator failures don't halt replay — we still emit a usable
    // assistant message with the tool summaries so the user sees state.
    logger.warn(
      `[automation-replay] narrator failed for turn ${turn.ordinal + 1}:`,
      err
    );
  }

  if (!narratorBody.trim()) {
    // Fallback body when the narrator produced nothing or threw.
    const summaryLines = structuredObservations
      .map(
        (o) =>
          `- ${o.tool}: ${o.metrics.outputRowCount ?? "?"} rows in ${o.metrics.durationMs}ms`
      )
      .join("\n");
    narratorBody = `Replayed against the new dataset.\n\n${summaryLines}`;
  }

  // Charts: prefer freshly-emitted tool charts (already bound to new
  // data). Fall back to the saved chart templates ONLY after stripping
  // their `data[]` arrays so we don't render stale numbers from the
  // captured session — better to render an empty chart shell than a
  // wrong one. Edge case fires for recipes with no analytical step
  // (pure clarify / computed-col turns).
  const finalCharts: ChartSpec[] | undefined =
    charts.length > 0
      ? charts
      : turn.charts?.map((c) => ({ ...c, data: undefined }));

  // Rebind any saved dashboard draft's chart entries to the freshly bound
  // charts so the dashboard renders NEW data, not the captured session's
  // numbers. Keyed by the axis-aware `chartIdentityKey` (WR5) so two same-title
  // charts that differ in breakdown each rebind to their OWN data.
  const rebindDashboardDraft = (
    draft: Message["dashboardDraft"]
  ): Message["dashboardDraft"] => rebindDashboardDraftCharts(draft, finalCharts);

  // Cap the `steps` payload we attach to agentTrace so a 60-step recipe
  // with bulky tool args doesn't push the persisted message size up.
  // The numeric cap matches AGENT_TRACE_MAX_BYTES intent (40k) — we
  // truncate by step count, since each saved step's args are bounded by
  // the planStepSchema upstream.
  const cappedSteps = turn.planSteps.slice(0, 30);

  const assistantMessage: Message = {
    role: "assistant",
    content: narratorBody,
    timestamp: Date.now(),
    replayedFromAutomationId: automationId,
    charts: finalCharts,
    pivotDefaults: turn.pivotDefaults,
    answerEnvelope,
    insights: insights.length > 0 ? insights : undefined,
    // Rebound from the saved recipe with chart data refilled from the
    // freshly-emitted tool outputs. The existing client-side dashboard
    // auto-create flow now re-creates the dashboard against the live
    // numbers, not the captured session's snapshot.
    dashboardDraft: rebindDashboardDraft(
      turn.dashboardDraft as Message["dashboardDraft"]
    ),
    // Carry a capped slice of the (remapped) plan steps onto agentTrace
    // so the chat history shows the same inspection surface as a live
    // turn without bloating the message.
    agentTrace: {
      turnId,
      steps: cappedSteps,
      replayed: true,
      automationId,
    },
  };

  // Wave A8 v3 · spawn the post-verifier business-actions agent so
  // replayed turns get the same decision-grade action items as live
  // turns (when BUSINESS_ACTIONS_ENABLED). Hard-skips when the envelope
  // is too thin; never throws. Awaited inline (replay is sequential by
  // design — no need for the live agent's promise-attach pattern).
  if (answerEnvelope && isBusinessActionsEnabled()) {
    try {
      const items = await runBusinessActions(ctx, answerEnvelope, {
        turnId: `${turnId}_business_actions`,
      });
      if (items.length > 0) {
        assistantMessage.businessActions = items;
      }
    } catch (err) {
      // runBusinessActions catches everything internally, but defence
      // in depth — never let it derail replay.
      logger.warn("[automation-replay] businessActions failed:", err);
    }
  }

  return {
    assistantMessage,
    dashboardCreated: Boolean(turn.dashboardDraft),
  };
};

/** Build a fresh AgentExecutionContext for the target session. */
const buildReplayContext = async (
  chat: ChatDocument,
  username: string,
  question: string,
  /** WR1 · the recipe's saved permanentContext (was `automation` — widened so
   *  an in-place refresh, which has no Automation doc, can supply it directly). */
  savedPermanentContext: string | undefined,
  abortSignal?: AbortSignal
): Promise<AgentExecutionContext> => {
  // Always read the canonical (unfiltered) dataset for replay. The
  // active-filter view is a UI-state convenience for live chat; replay
  // semantics demand the same row scope the original automation saw.
  // Same convention as `ensureSessionDuckdbMaterialized` / agent
  // rematerialize path (Wave-FA2).
  const data = await loadLatestData(chat, undefined, undefined, {
    skipActiveFilter: true,
  }).catch((err) => {
    logger.warn("[automation-replay] loadLatestData failed:", err);
    return chat.rawData ?? [];
  });
  const { text: domainContext } = await loadEnabledDomainContext().catch(() => ({
    text: "",
  }));

  // Stitch in the saved permanentContext if the target chat doesn't have
  // one. We don't overwrite — the target session's own intent wins.
  const permanentContext =
    chat.permanentContext?.trim().length
      ? chat.permanentContext
      : savedPermanentContext;

  return buildAgentExecutionContext({
    sessionId: chat.sessionId ?? chat.id,
    username,
    question,
    data,
    summary: chat.dataSummary,
    chatHistory: (chat.messages ?? []) as Message[],
    chatInsights: chat.insights,
    mode: "analysis",
    permanentContext,
    domainContext: domainContext || undefined,
    sessionAnalysisContext: chat.sessionAnalysisContext,
    chatDocument: chat,
    loadFullData: () =>
      loadLatestData(chat, undefined, undefined, { skipActiveFilter: true }),
    abortSignal,
  });
};

/**
 * Wave A8 v3 · Persist the saved automation's `permanentContext` and
 * slim `sessionAnalysisContext` seed onto the new chat document, but
 * only when the new chat doesn't already have its own. The new
 * session's user-set values always win.
 *
 * Best-effort: failures log a warning but never derail replay — the
 * narrator already has the values via `ctx`, so the only loss on
 * persist failure is post-replay reload visibility.
 */
const persistAutomationContextOntoChat = async (
  chat: ChatDocument,
  sessionTransformations: Automation["sessionTransformations"],
  username: string
): Promise<void> => {
  try {
    const savedCtx = sessionTransformations.permanentContext;
    if (
      typeof savedCtx === "string" &&
      savedCtx.trim().length > 0 &&
      !chat.permanentContext?.trim().length
    ) {
      await updateSessionPermanentContext(chat.sessionId, username, savedCtx);
      chat.permanentContext = savedCtx;
    }

    const seed = sessionTransformations.seedSessionAnalysisContext;
    if (seed && !chat.sessionAnalysisContext) {
      // Best-effort merge — `seed` is a partial of the schema; cast
      // through unknown because the SAC type is more specific than
      // `partial.deep` and the assistant-merge LLM normally fills in
      // the gaps. The next live turn will refine via the normal merge.
      const sac = seed as unknown as typeof chat.sessionAnalysisContext;
      // SEC-2: persist via the `mutateChatDocument` seam (invariant #9) — lock +
      // IfMatch `_etag` retry — instead of a bare get→mutate→`updateChatDocument`
      // on a stale snapshot. The mutator re-checks the FRESH doc, so a SAC seeded
      // by a concurrent live turn is never clobbered.
      await mutateChatDocument(chat.sessionId, (doc) => {
        if (doc.sessionAnalysisContext) return false; // already set — no write
        doc.sessionAnalysisContext = sac;
        return true;
      });
      chat.sessionAnalysisContext = sac; // keep the in-memory snapshot consistent
    }
  } catch (err) {
    logger.warn("[automation-replay] context persist failed:", err);
  }
};

let __sharedRegistry: ToolRegistry | null = null;
const getRegistry = (): ToolRegistry => {
  if (!__sharedRegistry) {
    __sharedRegistry = new ToolRegistry();
    registerDefaultTools(__sharedRegistry);
  }
  return __sharedRegistry;
};

/**
 * Wave WR1 · OVERWRITE-mode pre-step (in-place data refresh). Snapshots the
 * chat's current conversation + charts into `messageVersions` (newest-first,
 * capped) for rollback, then truncates the chat to its WELCOME PREFIX (every
 * message before the first user question) and clears the charts array.
 *
 * Clearing `charts` / `chartReferences` is load-bearing: `addMessageToChat`
 * dedups incoming charts by the axis-aware `chartIdentityKey`, so if the stale
 * pre-refresh charts stayed, the freshly-replayed charts with the SAME identity
 * would be deduped OUT and the chat would keep the OLD data (the L-010 trap).
 *
 * Returns the welcome prefix so the caller can keep the in-memory `chat`
 * consistent with what was persisted. Routes through `mutateChatDocument`
 * (lock + IfMatch retry, invariant #9).
 */
/** Max retained pre-refresh message snapshots (Cosmos doc-size ceiling guard). */
const MESSAGE_VERSIONS_CAP = 2;

/**
 * @internal Pure core of the overwrite-mode truncation (exported for tests).
 * Computes the welcome prefix (every message before the first user question)
 * and the new newest-first `messageVersions` array (capped), given the chat's
 * prior state. `now` is injected for deterministic tests.
 */
export const computeRefreshTruncation = (
  prior: Pick<
    ChatDocument,
    "messages" | "charts" | "chartReferences" | "currentDataBlob" | "messageVersions"
  >,
  now: number,
  versionLabel?: string
): {
  welcomePrefix: Message[];
  messageVersions: NonNullable<ChatDocument["messageVersions"]>;
} => {
  const msgs = (prior.messages ?? []) as Message[];
  const firstUserIdx = msgs.findIndex((m) => m.role === "user");
  const welcomePrefix =
    firstUserIdx === -1 ? [...msgs] : msgs.slice(0, firstUserIdx);
  const snapshot = {
    versionId: `msgs_${prior.currentDataBlob?.version ?? 0}_${now}`,
    dataVersion: prior.currentDataBlob?.version,
    label: versionLabel,
    snapshotAt: now,
    messages: msgs,
    charts: prior.charts ?? [],
    chartReferences: prior.chartReferences ?? [],
  };
  const messageVersions = [snapshot, ...(prior.messageVersions ?? [])].slice(
    0,
    MESSAGE_VERSIONS_CAP
  );
  return { welcomePrefix, messageVersions };
};

const snapshotAndTruncateForRefresh = async (
  chat: ChatDocument,
  sessionId: string,
  versionLabel?: string
): Promise<Message[]> => {
  let welcomePrefix: Message[] = [];
  await mutateChatDocument(sessionId, (doc) => {
    const result = computeRefreshTruncation(doc, Date.now(), versionLabel);
    welcomePrefix = result.welcomePrefix;
    doc.messageVersions = result.messageVersions;
    // Truncate analytical history; charts rebuild as turns replay.
    doc.messages = welcomePrefix;
    doc.charts = [];
    doc.chartReferences = [];
    return true;
  });
  return welcomePrefix;
};

/**
 * Wave A8 · Replay a saved Automation onto a (typically fresh) target session.
 * Thin loader: resolves the Automation doc → `RecipeSource`, delegates to the
 * extracted `replayRecipe` in append-messages mode, and touches lastRun.
 */
export async function replayAutomation(
  args: ReplayAutomationArgs
): Promise<ReplayAutomationResult> {
  const { automationId, username } = args;
  const automation = await getAutomationById(automationId, username);
  if (!automation) {
    return {
      ok: false,
      questionsReplayed: 0,
      dashboardsCreated: 0,
      error: "Automation not found",
    };
  }
  const source: RecipeSource = {
    recipe: automation.recipe,
    expectedSchema: automation.expectedSchema,
    sessionTransformations: automation.sessionTransformations,
    name: automation.name,
    sourceId: automation.id,
  };
  const result = await replayRecipe({
    sessionId: args.sessionId,
    source,
    username,
    columnMapping: args.columnMapping,
    resumeFromOrdinal: args.resumeFromOrdinal,
    mode: "append-messages",
    emit: args.emit,
    abortSignal: args.abortSignal,
  });
  if (result.ok) void touchAutomationLastRun(automationId, username);
  return result;
}

/**
 * Wave WR1 · the extracted deterministic replay core. Walks a `RecipeSource`
 * turn by turn against a TARGET session, dispatching saved plan steps through
 * the ToolRegistry and running the live narrator. Drives both automation
 * replay (`mode: 'append-messages'`) and in-place data refresh
 * (`mode: 'overwrite'`). Emits the same `automation_*` SSE events either way,
 * so the existing `AutomationReplayBanner` renders both.
 */
export async function replayRecipe(
  args: ReplayRecipeArgs
): Promise<ReplayAutomationResult> {
  const { sessionId, source, username, emit, abortSignal, mode } = args;
  const automationId = source.sourceId;
  const mapping = args.columnMapping ?? {};
  const aborted = () => abortSignal?.aborted === true;

  // 1. Load target chat + ownership check.
  const chat = await getChatDocument(sessionId, username);
  if (!chat) {
    return {
      ok: false,
      questionsReplayed: 0,
      dashboardsCreated: 0,
      error: "Target chat session not found",
    };
  }

  emit({
    type: "automation_started",
    automationId,
    recipeLength: source.recipe.length,
  });

  // 2. Mapping validation.
  const newColumnNames = new Set(
    chat.dataSummary?.columns?.map((c) => c.name) ?? []
  );
  const unresolved = findUnresolvedColumns(
    source.expectedSchema.finalColumns,
    mapping,
    newColumnNames
  );
  if (unresolved.length > 0) {
    const error = `Column mapping is incomplete or invalid. Unresolved: ${unresolved.join(", ")}.`;
    emit({ type: "automation_halted", ordinal: 0, error });
    return {
      ok: false,
      questionsReplayed: 0,
      dashboardsCreated: 0,
      error,
    };
  }

  // 2.5 OVERWRITE (in-place refresh): snapshot the prior conversation for
  // rollback, then truncate the chat so the replayed turns land on a clean
  // welcome prefix. No-op for append-messages (automation) mode.
  if (mode === "overwrite") {
    chat.messages = await snapshotAndTruncateForRefresh(chat, sessionId);
    chat.charts = [];
    chat.chartReferences = [];
  }

  // 3. Apply mapping → live recipe (immutable input preserved).
  const liveRecipe = applyColumnMappingToRecipe(source.recipe, mapping);

  // 4. Plan + APPLY upfront transformations.
  //    Critical contract from the user's clarification:
  //      "create all temporal columns necessary for that analysis. So basically
  //       you revisit the final dataset for the original analysis saved as
  //       automation, and replicate the schema and the way those extra
  //       columns were created/deleted/modified, and complete the dataset
  //       before replaying the recipe."
  //    The new upload pipeline already runs wide-format auto-detect, but it
  //    can fail to classify when the new file's column names drift enough.
  //    This block is the safety net: when the saved automation expects long
  //    form AND the new dataset isn't already long, force the saved transform.
  const transformPlan = planSessionTransformations(
    chat.dataSummary,
    source
  );
  for (let i = 0; i < transformPlan.steps.length; i++) {
    if (aborted()) {
      emit({
        type: "automation_halted",
        ordinal: 0,
        error: "Cancelled by client",
      });
      return {
        ok: false,
        questionsReplayed: 0,
        dashboardsCreated: 0,
        error: "Cancelled by client",
      };
    }
    const step = transformPlan.steps[i]!;
    const detail =
      step.kind === "wide_format_remelt"
        ? "Re-applying wide-format melt"
        : step.kind === "copy_permanent_context"
          ? "Copying permanent context"
          : "Seeding session analysis context";
    emit({
      type: "automation_progress",
      phase: "preparing_dataset",
      step: i + 1,
      total: transformPlan.steps.length,
      detail,
    });

    if (step.kind === "wide_format_remelt") {
      const wf = source.sessionTransformations.wideFormatTransform;
      if (wf && chat.dataSummary) {
        try {
          // Load the canonical (unfiltered) row data so the melt sees
          // the same scope every analytical tool will see at replay.
          const rawRows = await loadLatestData(chat, undefined, undefined, {
            skipActiveFilter: true,
          });
          // Stamp the saved transform onto the new chat's summary so
          // `applyWideFormatMeltIfNeeded` reads it and re-melts.
          applyWideFormatTransformToSummary(chat.dataSummary, wf);
          const meltResult = applyWideFormatMeltIfNeeded(
            rawRows,
            chat.dataSummary
          );
          if (meltResult.remelted) {
            // Persist the melted long-form rows as a new blob version on
            // the new session, then refresh the summary from the long
            // shape. Subsequent tools see the post-melt schema.
            await saveModifiedData(
              chat.sessionId,
              meltResult.rows,
              "wide_format_remelt_for_automation",
              `Wide-format remelt forced by replay of "${source.name}".`,
              chat
            );
            const fresh = createDataSummary(meltResult.rows);
            // Re-stamp wide-format meta after summary regen so the
            // analytical layer recognises the long shape.
            applyWideFormatTransformToSummary(fresh, wf);
            chat.dataSummary = fresh;
            chat.rawData = meltResult.rows;
            logger.log(
              `[automation-replay] forced wide-format remelt produced ${meltResult.rows.length} long-form rows`
            );
          }
        } catch (err) {
          // Don't halt on remelt failure — the user's clarification
          // implies we should be aggressive here, but a cleaner UX is
          // to let the analytical step itself fail with a clear error.
          // Log loudly so ops can spot it.
          logger.warn(
            "[automation-replay] wide-format remelt failed; continuing — analytical tools will surface the schema mismatch:",
            err
          );
        }
      }
    } else if (step.kind === "copy_permanent_context") {
      // Persisted in `persistAutomationContextOntoChat` below (it
      // batches both context-copy paths so the chat doc is upserted
      // once instead of twice).
    } else if (step.kind === "seed_session_analysis_context") {
      // Same — persisted below.
    }
  }

  // Persist saved permanentContext + sessionAnalysisContext seed onto
  // the new chat (best-effort; never derails replay). Done after the
  // transform loop so a single Cosmos round-trip carries both.
  await persistAutomationContextOntoChat(
    chat,
    source.sessionTransformations,
    username
  );

  if (aborted()) {
    emit({
      type: "automation_halted",
      ordinal: 0,
      error: "Cancelled by client",
    });
    return {
      ok: false,
      questionsReplayed: 0,
      dashboardsCreated: 0,
      error: "Cancelled by client",
    };
  }

  // 5. Build a single replay context, reused across turns.
  const registry = getRegistry();
  const startOrdinal = Math.max(0, args.resumeFromOrdinal ?? 0);
  let questionsReplayed = 0;
  let dashboardsCreated = 0;

  // Build the context once — the per-turn loop refreshes question + blackboard.
  let ctx: AgentExecutionContext;
  try {
    ctx = await buildReplayContext(
      chat,
      username,
      liveRecipe[startOrdinal]?.question ?? "",
      source.sessionTransformations.permanentContext,
      abortSignal
    );
  } catch (err) {
    const error = errorMessage(err);
    emit({ type: "automation_halted", ordinal: startOrdinal, error });
    return {
      ok: false,
      questionsReplayed: 0,
      dashboardsCreated: 0,
      haltedAtOrdinal: startOrdinal,
      error,
    };
  }

  // 6. Iterate recipe turns.
  for (let i = startOrdinal; i < liveRecipe.length; i++) {
    if (aborted()) {
      emit({
        type: "automation_halted",
        ordinal: i,
        error: "Cancelled by client",
      });
      return {
        ok: false,
        questionsReplayed,
        dashboardsCreated,
        haltedAtOrdinal: i,
        error: "Cancelled by client",
      };
    }

    const turn = liveRecipe[i]!;
    const turnId = `automation_${automationId}_turn_${i}`;

    // 6a. Persist user message.
    const userMessage: Message = {
      role: "user",
      content: turn.question,
      timestamp: Date.now(),
    };
    try {
      await addMessageToChat(chat.id, username, userMessage);
      // Refresh `ctx.chatHistory` so any tool / agent that consults it
      // (today: none, but defensive) sees the messages persisted by
      // earlier turns of THIS replay run.
      ctx.chatHistory = [...(ctx.chatHistory ?? []), userMessage];
    } catch (err) {
      const error = errorMessage(err);
      emit({ type: "automation_halted", ordinal: i, error });
      return {
        ok: false,
        questionsReplayed,
        dashboardsCreated,
        haltedAtOrdinal: i,
        error,
      };
    }

    // 6b. Per-turn progress.
    emit({
      type: "automation_progress",
      phase: "replaying_turn",
      step: i + 1,
      total: liveRecipe.length,
      detail: turn.question.slice(0, 120),
    });

    // 6c-e. Execute deterministic playback.
    let stepResult: {
      assistantMessage: Message;
      dashboardCreated: boolean;
    };
    try {
      stepResult = await executeReplayTurn({
        ctx,
        registry,
        turn,
        automationId,
        turnId,
      });
    } catch (err) {
      const isReplayErr = err instanceof ReplayStepError;
      const error = errorMessage(err);
      emit({
        type: "automation_halted",
        ordinal: i,
        stepId: isReplayErr ? err.stepId : undefined,
        error,
      });
      return {
        ok: false,
        questionsReplayed,
        dashboardsCreated,
        haltedAtOrdinal: i,
        error,
      };
    }

    // 6f. Persist assistant message.
    try {
      await addMessageToChat(chat.id, username, stepResult.assistantMessage);
      // Same chatHistory refresh as the user-message persist above.
      ctx.chatHistory = [
        ...(ctx.chatHistory ?? []),
        stepResult.assistantMessage,
      ];
    } catch (err) {
      const error = errorMessage(err);
      emit({ type: "automation_halted", ordinal: i, error });
      return {
        ok: false,
        questionsReplayed,
        dashboardsCreated,
        haltedAtOrdinal: i,
        error,
      };
    }

    questionsReplayed += 1;
    if (stepResult.dashboardCreated) dashboardsCreated += 1;
  }

  // 7. Success. (`touchAutomationLastRun` is the automation loader's concern,
  // applied in `replayAutomation` once this returns ok — a refresh has no
  // Automation doc to touch.)
  emit({
    type: "automation_complete",
    questionsReplayed,
    dashboardsCreated,
  });
  return {
    ok: true,
    questionsReplayed,
    dashboardsCreated,
  };
}
