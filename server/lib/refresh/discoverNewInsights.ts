/**
 * Wave WR11 (incremental refresh) · fresh-planner discovery pass.
 *
 * A faithful refresh reproduces the SAME questions on the new data. But more
 * data can enable NEW analyses (a month-over-month trend that didn't exist with
 * one month, a segment that only now stands out). This optional pass runs the
 * FULL agent loop (planner included — not a deterministic replay) on a handful
 * of fresh questions the chat hasn't answered yet, and appends the results as
 * new turns. Opt-in (a checkbox in the refresh modal); it runs AFTER the
 * faithful replay, on the same SSE stream.
 *
 * Cost-bounded: caps the number of discovery turns; never throws (a discovery
 * failure must not undo the successful refresh).
 */

import type { ChatDocument } from "../../models/chat.model.js";
import { addMessageToChat } from "../../models/chat.model.js";
import { loadLatestData } from "../../utils/dataLoader.js";
import { answerQuestion } from "../dataAnalyzer.js";
import type { Message } from "../../shared/schema.js";
import type { ReplaySseEmit } from "../automations/replayLoop.service.js";
import { logger } from "../logger.js";

const DEFAULT_MAX = 3;

const normalize = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Pure: choose up to `max` discovery questions from the freshly-suggested
 * follow-ups / profile questions that the chat hasn't already answered.
 * Falls back to one generic discovery prompt when nothing fresh is available.
 * Exported for tests.
 */
export function selectDiscoveryQuestions(
  chat: Pick<ChatDocument, "messages" | "sessionAnalysisContext" | "datasetProfile">,
  max: number = DEFAULT_MAX
): string[] {
  const answered = new Set(
    (chat.messages ?? [])
      .filter((m) => m.role === "user")
      .map((m) => normalize(m.content ?? ""))
  );
  const sac = chat.sessionAnalysisContext as
    | { suggestedFollowUps?: string[] }
    | undefined;
  const candidates = [
    ...(sac?.suggestedFollowUps ?? []),
    ...(chat.datasetProfile?.suggestedQuestions ?? []),
  ];
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const q of candidates) {
    const n = normalize(q);
    if (!n || answered.has(n) || seen.has(n)) continue;
    seen.add(n);
    fresh.push(q);
    if (fresh.length >= max) break;
  }
  if (fresh.length === 0) {
    return [
      "What are the most important new trends or changes now visible in this dataset?",
    ];
  }
  return fresh;
}

export interface DiscoverArgs {
  sessionId: string;
  username: string;
  chat: ChatDocument;
  maxQuestions?: number;
  emit: ReplaySseEmit;
  abortSignal?: AbortSignal;
}

export interface DiscoverResult {
  discovered: number;
}

/**
 * Run the discovery pass. Assumes the caller already holds the session turn
 * lease (it runs inside the refresh flow, which is exclusive).
 */
export async function discoverNewInsights(
  args: DiscoverArgs
): Promise<DiscoverResult> {
  const { sessionId, username, chat, emit, abortSignal } = args;
  const max = Math.max(1, Math.min(args.maxQuestions ?? DEFAULT_MAX, 5));
  let discovered = 0;
  try {
    const data = (await loadLatestData(chat, undefined, undefined, {
      skipActiveFilter: true,
    }).catch(() => chat.rawData ?? [])) as Record<string, any>[];
    if (!data.length) return { discovered: 0 };

    const questions = selectDiscoveryQuestions(chat, max);
    for (let i = 0; i < questions.length; i++) {
      if (abortSignal?.aborted) break;
      const q = questions[i]!;
      emit({
        type: "automation_progress",
        phase: "replaying_turn",
        step: i + 1,
        total: questions.length,
        detail: `Discovering: ${q.slice(0, 100)}`,
      });
      try {
        const result = await answerQuestion(
          data,
          q,
          (chat.messages ?? []) as Message[],
          chat.dataSummary,
          sessionId,
          chat.insights,
          undefined,
          "analysis",
          chat.permanentContext,
          chat.sessionAnalysisContext,
          undefined,
          () =>
            loadLatestData(chat, undefined, undefined, {
              skipActiveFilter: true,
            }) as Promise<Record<string, any>[]>,
          { username, chatDocument: chat, activeDirectives: chat.userDirectives, abortSignal }
        );
        const userMsg: Message = { role: "user", content: q, timestamp: Date.now() };
        const assistantMsg: Message = {
          role: "assistant",
          content: result.answer,
          timestamp: Date.now(),
          charts: result.charts,
          insights: result.insights,
          dashboardDraft: result.dashboardDraft,
        };
        await addMessageToChat(chat.id, username, userMsg);
        await addMessageToChat(chat.id, username, assistantMsg);
        discovered += 1;
      } catch (err) {
        logger.warn(`[refresh] discovery turn ${i + 1} failed (non-fatal):`, err);
      }
    }
  } catch (err) {
    logger.warn(`[refresh] discovery pass failed (non-fatal):`, err);
  }
  return { discovered };
}
