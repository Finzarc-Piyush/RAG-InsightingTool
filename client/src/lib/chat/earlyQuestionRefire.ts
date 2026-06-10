/**
 * Early-question re-fire helpers.
 *
 * When a user asks a question while their dataset is still enriching, the
 * server can't answer yet (the data table isn't materialized). Instead of the
 * server silently queuing+answering in the background, the CLIENT holds the
 * question and re-fires it as a normal streaming chat turn the moment the data
 * is truly ready — so the user gets the full live experience (thinking steps,
 * charts) for their early question.
 *
 * The subtlety this module encodes: there are TWO "complete" signals on the
 * upload poll and they are NOT equivalent.
 *   - `enrichmentStatus === 'complete'` flips EARLY, at the ~40% understanding
 *     checkpoint, BEFORE the columnar/Parquet data table exists. Re-firing on
 *     it would hit unmaterialized data.
 *   - `status === 'completed'` is set only at the very end of the upload job,
 *     after the final enrichment write. It is the ONLY signal that means
 *     "fully materialized + safe to answer".
 * So we gate the re-fire strictly on `status === 'completed'`.
 */

/** A question the user asked while the dataset was still enriching. */
export interface QueuedEarlyQuestion {
  content: string;
  timestamp: number;
}

/**
 * True only when the dataset is fully materialized (`status === 'completed'`)
 * AND a question is waiting to be re-fired. Deliberately ignores
 * `enrichmentStatus === 'complete'` / `understandingReady` — those flip early,
 * before the data table exists.
 */
export function shouldRefireEarlyQuestion(
  status: { status?: string },
  queued: QueuedEarlyQuestion | null | undefined
): boolean {
  return queued != null && status.status === "completed";
}

/**
 * While a question is queued and the upload poll has only reached the EARLY
 * `enrichmentStatus === 'complete'` (not yet the true `status === 'completed'`),
 * the poll must NOT tear itself down — otherwise it never observes the signal
 * that lets us re-fire. Returns true when the poll should keep running for the
 * sake of a pending re-fire.
 */
export function shouldHoldPollForRefire(
  status: { status?: string },
  hasQueued: boolean
): boolean {
  return hasQueued && status.status !== "completed";
}

// --- sessionStorage durability (survives a tab reload mid-enrichment) -------

const STORAGE_PREFIX = "marico:queuedEarlyQuestion:";

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

/** Pure: validate/normalize a parsed value into a QueuedEarlyQuestion. */
export function parseQueuedQuestion(raw: unknown): QueuedEarlyQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const { content, timestamp } = raw as Record<string, unknown>;
  if (typeof content !== "string" || content.trim().length === 0) return null;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  return { content, timestamp };
}

/** Pure: serialize for storage. */
export function serializeQueuedQuestion(q: QueuedEarlyQuestion): string {
  return JSON.stringify({ content: q.content, timestamp: q.timestamp });
}

export function persistQueuedQuestion(sessionId: string, q: QueuedEarlyQuestion): void {
  if (typeof sessionStorage === "undefined" || !sessionId) return;
  try {
    sessionStorage.setItem(storageKey(sessionId), serializeQueuedQuestion(q));
  } catch {
    /* storage full / disabled — durability is best-effort */
  }
}

export function readQueuedQuestion(sessionId: string): QueuedEarlyQuestion | null {
  if (typeof sessionStorage === "undefined" || !sessionId) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(sessionId));
    if (!raw) return null;
    return parseQueuedQuestion(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearQueuedQuestion(sessionId: string): void {
  if (typeof sessionStorage === "undefined" || !sessionId) return;
  try {
    sessionStorage.removeItem(storageKey(sessionId));
  } catch {
    /* ignore */
  }
}
