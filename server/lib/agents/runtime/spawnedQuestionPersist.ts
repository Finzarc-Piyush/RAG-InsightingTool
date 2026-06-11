/**
 * ============================================================================
 * spawnedQuestionPersist.ts — the {id, question} subset persisted on a message
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The reflector emits rich `SpawnedQuestion`s (question + spawnReason + priority
 *   + suggestedColumns + id). The assistant message only needs the {id, question}
 *   subset so per-question feedback (thumbs up/down) survives a reload. This pure
 *   function does that projection: drop anything without BOTH a string id and a
 *   string question, keep order, and cap the count to the message-schema limit.
 *
 * WHY IT MATTERS (C6)
 *   answerQuestion used to drop `spawnedQuestions` from its return, so the chips
 *   were live-SSE-only and vanished on reload. With the field now forwarded,
 *   chatStream persists this subset. Extracting + testing the projection guards
 *   the persistence contract (shape + cap) that the bug exposed.
 *
 * HOW IT CONNECTS
 *   Called from chatStream.service.ts when building the assistant save object.
 *   The cap mirrors messageSchema.spawnedQuestions `.max(16)` in shared/schema.ts
 *   so a persist never fails zod validation.
 */

/** The message-schema cap (`messageSchema.spawnedQuestions.max(16)`). */
export const PERSISTED_SPAWNED_QUESTIONS_MAX = 16;

export interface PersistedSpawnedQuestion {
  id: string;
  question: string;
}

/**
 * Project rich spawned questions to the persistable {id, question} subset.
 * Drops entries missing a string id or question, preserves input order, and
 * caps at `max` (default = the message-schema limit). Pure.
 */
export function toPersistedSpawnedQuestions(
  spawned: ReadonlyArray<{ id?: unknown; question?: unknown } | null | undefined> | null | undefined,
  max: number = PERSISTED_SPAWNED_QUESTIONS_MAX
): PersistedSpawnedQuestion[] {
  if (!Array.isArray(spawned) || spawned.length === 0) return [];
  const out: PersistedSpawnedQuestion[] = [];
  for (const q of spawned) {
    if (out.length >= max) break;
    const id = q?.id;
    const question = q?.question;
    if (typeof id === "string" && id.length > 0 && typeof question === "string" && question.length > 0) {
      out.push({ id, question });
    }
  }
  return out;
}
