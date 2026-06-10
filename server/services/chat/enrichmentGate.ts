/**
 * Enrichment gate for the chat answer path.
 *
 * A question can only be answered once the dataset's enrichment is complete.
 * Both the streaming (chatStream.service) and non-streaming (chat.service)
 * paths share this 3-way decision:
 *
 *   - `proceed` — enrichment finished (or status unknown/legacy): answer normally.
 *   - `queued`  — enrichment still pending/in_progress: the CLIENT holds the
 *                 question and re-fires it as a normal streaming turn once the
 *                 data is ready (see client `earlyQuestionRefire`). The server
 *                 no longer persists a `pendingUserMessage` or auto-answers.
 *   - `failed`  — enrichment failed: surface an error.
 */
export type EnrichmentGate = "proceed" | "queued" | "failed";

export function decideEnrichmentGate(
  enrichmentStatus: string | undefined | null
): EnrichmentGate {
  if (enrichmentStatus === "pending" || enrichmentStatus === "in_progress") {
    return "queued";
  }
  if (enrichmentStatus === "failed") {
    return "failed";
  }
  return "proceed";
}
