/**
 * ============================================================================
 * autoTitleAnalysis.ts — name a new analysis from its first Q&A
 * ============================================================================
 * After the FIRST answered question of a brand-new analysis, replace the default
 * creation name (upload filename / `db.schema.table`) with a concise, context-
 * derived title — but only while the analysis is still eligible (no prior auto/
 * user title). The eligibility re-check + write live in `setAutoTitleIfEligible`
 * (a `mutateChatDocument` RMW), so a user rename racing the titler always wins.
 *
 * Design posture: never block, never break a turn.
 *   - Gated to the first answered turn (`priorMessageCount === 0`) + a flag.
 *   - The LLM call is MINI-tier, ~24 tokens, hard-capped at a 4s timeout.
 *   - ANY failure (timeout / API / schema) degrades to a deterministic title
 *     derived from the question text — the analysis is always titled, once.
 */

import { z } from "zod";
import { completeJson } from "../../lib/agents/runtime/llmJson.js";
import { LLM_PURPOSE } from "../../lib/agents/runtime/llmCallPurpose.js";
import { setAutoTitleIfEligible } from "../../models/chat.model.js";
import { isFlagOn } from "../../lib/featureFlags.js";
import { logger } from "../../lib/logger.js";
import { errorMessage } from "../../utils/errorMessage.js";

/** Hard cap on a generated title — keeps the sidebar readable and matches the
 *  `mutateChatDocument` write (which trims but does not clamp). */
const MAX_TITLE_LEN = 60;
const TITLE_TIMEOUT_MS = 4000;

const TitleSchema = z.object({
  title: z.string().min(3).max(MAX_TITLE_LEN),
});

const SYSTEM =
  "You name data-analysis sessions. Given the user's first question and the " +
  "assistant's answer, produce a concise 3-7 word analytical title in Title " +
  "Case that names the SUBJECT of the analysis. No quotes, no trailing " +
  "punctuation, no file extensions, no the word 'analysis'. " +
  'Respond as JSON: {"title": string}.';

/**
 * Clean an LLM-proposed (or any) title into a safe display string: strip
 * surrounding quotes, a trailing file extension, trailing punctuation, collapse
 * whitespace and clamp to MAX_TITLE_LEN. Pure — exported for tests.
 */
export function sanitizeTitle(raw: string): string {
  let t = (raw ?? "").replace(/\s+/g, " ").trim();
  // Strip a single pair of surrounding quotes.
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  // Drop a trailing file extension (e.g. "Sales.csv" → "Sales").
  t = t.replace(/\.(csv|xlsx?|tsv|json|parquet|txt)$/i, "").trim();
  // Drop trailing sentence punctuation.
  t = t.replace(/[.,;:!?]+$/g, "").trim();
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim();
  return t;
}

/**
 * Deterministic fallback title from the question text: strip a trailing "?",
 * collapse whitespace, keep the first ~8 words, sanitize and clamp. Always
 * returns a non-empty string (unless the question is empty). Pure — for tests.
 */
export function deterministicTitleFromQuestion(question: string): string {
  const cleaned = (question ?? "").replace(/\s+/g, " ").trim().replace(/\?+$/g, "");
  if (!cleaned) return "";
  const words = cleaned.split(" ").slice(0, 8).join(" ");
  return sanitizeTitle(words);
}

/** Race the LLM title generation against a timeout; never throws. */
async function generateTitle(
  question: string,
  answer: string,
  turnId?: string
): Promise<string> {
  try {
    const llm = await Promise.race([
      completeJson(SYSTEM, buildUserPrompt(question, answer), TitleSchema, {
        purpose: LLM_PURPOSE.ANALYSIS_TITLE,
        maxTokens: 24,
        temperature: 0.2,
        turnId,
      }),
      new Promise<{ ok: false }>((resolve) =>
        setTimeout(() => resolve({ ok: false }), TITLE_TIMEOUT_MS)
      ),
    ]);
    if (llm.ok) {
      const cleaned = sanitizeTitle(llm.data.title);
      if (cleaned.length >= 3) return cleaned;
    }
  } catch (err) {
    logger.warn?.("autoTitle: LLM title failed, using fallback:", errorMessage(err));
  }
  return deterministicTitleFromQuestion(question);
}

function buildUserPrompt(question: string, answer: string): string {
  return (
    `First question:\n${question.slice(0, 800)}\n\n` +
    `Assistant answer (excerpt):\n${(answer ?? "").slice(0, 1200)}`
  );
}

export interface MaybeAutoTitleArgs {
  sessionId: string;
  username: string;
  /** Message count on the chat doc BEFORE this turn appended. Titling fires only
   *  on the first answered turn (=== 0). */
  priorMessageCount: number;
  question: string;
  answer: string;
  turnId?: string;
}

/**
 * Title the analysis if it is the first answered turn and the analysis is still
 * eligible. Returns the new fileName when it renamed, else null. Never throws —
 * titling must not surface as a turn error.
 */
export async function maybeAutoTitleAnalysis(
  args: MaybeAutoTitleArgs
): Promise<string | null> {
  try {
    if (!isFlagOn("AUTO_TITLE_ANALYSIS_ENABLED")) return null;
    if (args.priorMessageCount !== 0) return null; // first answered turn only
    const question = (args.question ?? "").trim();
    if (!question) return null;
    const title = await generateTitle(question, args.answer, args.turnId);
    if (!title) return null;
    // The eligibility re-check inside the RMW keeps this single-fire + lets a
    // racing user rename win (it returns null when not eligible).
    return await setAutoTitleIfEligible(args.sessionId, args.username, title);
  } catch (err) {
    logger.warn?.("autoTitle: maybeAutoTitleAnalysis failed:", errorMessage(err));
    return null;
  }
}
