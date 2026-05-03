/**
 * Wave A3 · in-process persistence queue for chat-message Cosmos writes.
 *
 * Replaces the bare `await addMessagesBySessionId(...)` at the end of every
 * agent turn with a retrying writer that:
 *  1. Serialises writes per-session via the same in-process mutex pattern as
 *     `persistMergeAssistantSessionContext` (Wave W40) so a streaming append
 *     never races a debounced PATCH or another turn's save on the same chat
 *     doc.
 *  2. Retries transient Cosmos failures with exponential backoff (250 ms,
 *     1 s, 4 s) before giving up.
 *  3. Reports outcome via callbacks: `onSuccess`, `onAttemptFailed`,
 *     `onFailure`. The streaming chat service uses these to emit
 *     `persist_status` SSE events the client can render as a "saved at HH:MM"
 *     timestamp or, on terminal failure, a "Save again" affordance (Wave A5).
 *
 * The queue is intentionally simple — single Node process, no external broker.
 * A multi-instance deploy would need to migrate this to a durable queue + a
 * dead-letter store; per CLAUDE.md the deploy is single-instance today.
 */
import { randomUUID } from "crypto";
import {
  addMessagesBySessionId,
  type ChatDocument,
  type Message,
} from "../models/chat.model.js";

export type PersistOutcome = "succeeded" | "failed";

export interface PersistJob {
  id: string;
  sessionId: string;
  messages: Message[];
  attempts: number;
  maxAttempts: number;
  /** Fired exactly once on terminal success. */
  onSuccess?: (jobId: string) => void;
  /** Fired exactly once on terminal failure (after all retries exhausted). */
  onFailure?: (err: Error, jobId: string) => void;
  /** Fired after each failed attempt that will be retried (NOT on terminal fail). */
  onAttemptFailed?: (err: Error, attempt: number, jobId: string) => void;
}

export interface EnqueueOpts {
  sessionId: string;
  messages: Message[];
  maxAttempts?: number;
  onSuccess?: (jobId: string) => void;
  onFailure?: (err: Error, jobId: string) => void;
  onAttemptFailed?: (err: Error, attempt: number, jobId: string) => void;
  /** If true, fire-and-forget (caller does not await); the queue still
   *  serialises per-session and the callbacks still fire. Default true. */
  background?: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 1000, 4000];

const sessionWriteChain = new Map<string, Promise<unknown>>();
const inFlight = new Map<string, PersistJob>();

/**
 * Adapter for the message-list write. Tests can swap it via
 * `__setPersistWriter`; production uses `addMessagesBySessionId`.
 */
let writer: (sessionId: string, messages: Message[]) => Promise<ChatDocument> =
  addMessagesBySessionId;

export function __setPersistWriter(
  fn: (sessionId: string, messages: Message[]) => Promise<ChatDocument>
): () => void {
  const prev = writer;
  writer = fn;
  return () => {
    writer = prev;
  };
}

/**
 * Adapter for sleep — tests can swap to a synchronous version to skip
 * backoff waits.
 */
let sleeper: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function __setPersistSleeper(fn: (ms: number) => Promise<void>): () => void {
  const prev = sleeper;
  sleeper = fn;
  return () => {
    sleeper = prev;
  };
}

/**
 * Enqueue a chat-message write. Returns a job id for telemetry.
 *
 * `background: true` (default) returns immediately after the job is queued
 * (the work runs in a detached promise). `background: false` awaits the
 * outcome — useful in tests and where the caller really needs the synchronous
 * commit.
 */
export function enqueuePersist(opts: EnqueueOpts): {
  jobId: string;
  promise: Promise<PersistOutcome>;
} {
  const job: PersistJob = {
    id: randomUUID(),
    sessionId: opts.sessionId,
    messages: opts.messages,
    attempts: 0,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    onSuccess: opts.onSuccess,
    onFailure: opts.onFailure,
    onAttemptFailed: opts.onAttemptFailed,
  };
  inFlight.set(job.id, job);

  const previous = sessionWriteChain.get(job.sessionId);
  const work: Promise<PersistOutcome> = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // a prior caller's failure is its own concern — proceed anyway
      }
    }
    return runWithRetry(job);
  })();
  sessionWriteChain.set(job.sessionId, work);
  void work.finally(() => {
    if (sessionWriteChain.get(job.sessionId) === work) {
      sessionWriteChain.delete(job.sessionId);
    }
    inFlight.delete(job.id);
  });

  return { jobId: job.id, promise: work };
}

async function runWithRetry(job: PersistJob): Promise<PersistOutcome> {
  let lastErr: unknown;
  while (job.attempts < job.maxAttempts) {
    job.attempts++;
    try {
      await writer(job.sessionId, job.messages);
      try {
        job.onSuccess?.(job.id);
      } catch (cbErr) {
        console.warn("persistenceQueue: onSuccess callback threw:", cbErr);
      }
      return "succeeded";
    } catch (err) {
      lastErr = err;
      const e = toError(err);
      const isTerminal = job.attempts >= job.maxAttempts;
      if (!isTerminal) {
        try {
          job.onAttemptFailed?.(e, job.attempts, job.id);
        } catch (cbErr) {
          console.warn("persistenceQueue: onAttemptFailed callback threw:", cbErr);
        }
        const wait = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
        await sleeper(wait);
        continue;
      }
      try {
        job.onFailure?.(e, job.id);
      } catch (cbErr) {
        console.warn("persistenceQueue: onFailure callback threw:", cbErr);
      }
      console.error(
        `❌ persistenceQueue: session=${job.sessionId} job=${job.id} ` +
          `${job.maxAttempts} attempts exhausted. Last error: ${e.message}`
      );
      return "failed";
    }
  }
  // Unreachable, but TypeScript demands a return.
  throw lastErr instanceof Error ? lastErr : new Error("persistenceQueue: unreachable");
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" ? e : JSON.stringify(e));
}

/** Test/observability hook — count of jobs currently being processed. */
export function getInFlightCount(): number {
  return inFlight.size;
}

/** Test/observability hook — list of (sessionId) chains currently active. */
export function getActiveChainSessions(): string[] {
  return Array.from(sessionWriteChain.keys());
}
