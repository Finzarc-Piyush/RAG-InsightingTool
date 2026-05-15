/**
 * Patch the assistant message's `answerEnvelope.businessActions` field on
 * a persisted Cosmos chat document — used by the post-verifier
 * businessActionsAgent path which resolves AFTER the primary message
 * persist has already run.
 *
 * Why a second write rather than blocking the first persist on the agent's
 * resolution: the user-facing contract for the response event timing must
 * not regress. The primary persist + response SSE happen at the moment
 * they do today; this helper fires AFTER the response event so the agent
 * has a few seconds of headroom without delaying anything the user can
 * see. If the patch fails or times out, the user simply sees no business
 * actions section — the analytical answer is unaffected.
 *
 * Wave A2 · Now serialised against EVERY other Cosmos-facing RMW on the
 * same session (assistant-merge, hierarchy writes, schema-annotation
 * writes, active-filter PUT/DELETE) via the unified
 * `withSessionWriteLock` helper. Pre-A2 this file held its own
 * `sessionPatchChain` map that only serialised BAI-vs-BAI; concurrent
 * writes from sessionAnalysisContext.ts or activeFilterController.ts
 * would race against the BAI patch's RMW of `messages[]`.
 */

import type { Message } from "../shared/schema.js";
import { withSessionWriteLock } from "./sessionWriteLock.js";

type BusinessActions = NonNullable<Message["businessActions"]>;

export async function patchAssistantBusinessActions(params: {
  sessionId: string;
  username: string;
  messageTimestamp: number;
  items: BusinessActions;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!params.items?.length) return { ok: true, reason: "empty" };

  return withSessionWriteLock(params.sessionId, () => doPatch(params));
}

async function doPatch(params: {
  sessionId: string;
  username: string;
  messageTimestamp: number;
  items: BusinessActions;
}): Promise<{ ok: boolean; reason?: string }> {
  const { getChatBySessionIdForUser, updateChatDocument } = await import(
    "../models/chat.model.js"
  );
  const doc = await getChatBySessionIdForUser(
    params.sessionId,
    params.username
  );
  if (!doc) return { ok: false, reason: "session_not_found" };
  if (!Array.isArray(doc.messages) || doc.messages.length === 0) {
    return { ok: false, reason: "no_messages" };
  }
  const idx = doc.messages.findIndex(
    (m) => m.role === "assistant" && m.timestamp === params.messageTimestamp
  );
  if (idx === -1) return { ok: false, reason: "message_not_found" };

  const target = doc.messages[idx];
  doc.messages[idx] = { ...target, businessActions: params.items };
  await updateChatDocument(doc);
  return { ok: true };
}
