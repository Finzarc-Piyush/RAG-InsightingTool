/**
 * Cosmos model for the `past_analyses` container.
 *
 * Source-of-truth for completed turns. Written fire-and-forget by the chat
 * stream (W2.3) right before the `response` SSE goes out, then mirrored to
 * AI Search (W2.4) for the semantic question cache (W5.*).
 *
 * Lazy container initialization mirrors `llmUsage.model.ts` so a Cosmos hiccup
 * at startup cannot block the agent loop. First write that actually needs the
 * container creates it on demand.
 */

import { Container } from "@azure/cosmos";
import { getDatabase, initializeCosmosDB } from "./database.config.js";
import {
  pastAnalysisDocSchema,
  type PastAnalysisDoc,
  type PastAnalysisFeedbackTarget,
  type PastAnalysisFeedbackDetail,
  type PastAnalysisPivotArtifact,
} from "../shared/schema.js";
import type { BusinessActionItem } from "../shared/schema.js";

export const COSMOS_PAST_ANALYSES_CONTAINER_ID =
  process.env.COSMOS_PAST_ANALYSES_CONTAINER_ID || "past_analyses";

let pastAnalysesContainerInstance: Container | null = null;

/**
 * Wave A3 · Per-doc promise chain that serialises every read-modify-write
 * on a single past-analysis document (keyed by `${sessionId}__${turnId}`).
 *
 * Pre-A3 the chat stream fired three independent fire-and-forget writes to
 * the same doc and let Cosmos's last-writer-wins resolve them:
 *
 *   1. `upsertPastAnalysisDoc` (initial doc body, awaited inside a void
 *      promise chain at `chatStream.service.ts: ~line 327`).
 *   2. `patchPastAnalysisBusinessActions` — RMW chain (`get → patch → upsert`)
 *      that ran later, when the post-verifier `businessActionsPromise`
 *      resolved.
 *   3. `patchPastAnalysisPivotArtifacts` — RMW chain (`get → patch → upsert`)
 *      that ran inside the same `.then` branch as the initial upsert.
 *
 * If patch (2) reads doc state X and patch (3) reads state Y (== X +
 * businessActions) but patch (2) writes X back AFTER patch (3), the
 * pivotArtifacts field disappears. Symmetric collision in the other
 * order drops businessActions. The cache mirror ends up with at most one
 * of the three fields when both patches race.
 *
 * Fix: per-doc serialisation. Different docs (different turns, different
 * sessions) still parallelise — this lock is specifically about the
 * three concurrent writers for the SAME doc.
 *
 * Scope decision: NOT the session-level `withSessionWriteLock` (Wave A2)
 * because this cache mirror should never block the live response path's
 * Cosmos writes. The chat-doc lock and the past-analyses lock are
 * orthogonal — they touch different Cosmos containers.
 */
const pastAnalysisDocChain = new Map<string, Promise<unknown>>();

async function withPastAnalysisDocLock<T>(
  docId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = pastAnalysisDocChain.get(docId);
  const work = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        /* prior call's failure is its own concern */
      }
    }
    return fn();
  })();
  pastAnalysisDocChain.set(docId, work);
  try {
    return await work;
  } finally {
    if (pastAnalysisDocChain.get(docId) === work) {
      pastAnalysisDocChain.delete(docId);
    }
  }
}

/** Test-only escape hatch — number of in-flight per-doc locks. */
export function __pastAnalysisDocChainSizeForTesting(): number {
  return pastAnalysisDocChain.size;
}

/** Test-only escape hatch — drop every in-flight lock. */
export function __resetPastAnalysisDocChainForTesting(): void {
  pastAnalysisDocChain.clear();
}

/** Lazily resolve (and create on first call) the `past_analyses` container. */
export async function waitForPastAnalysesContainer(
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Container> {
  if (pastAnalysesContainerInstance) return pastAnalysesContainerInstance;

  try {
    await initializeCosmosDB();
  } catch {
    /* fall through to retry loop */
  }

  for (let i = 0; i < maxRetries; i++) {
    const db = getDatabase();
    if (db) {
      try {
        const { container } = await db.containers.createIfNotExists({
          id: COSMOS_PAST_ANALYSES_CONTAINER_ID,
          partitionKey: "/sessionId",
        });
        pastAnalysesContainerInstance = container;
        return container;
      } catch {
        const ref = db.container(COSMOS_PAST_ANALYSES_CONTAINER_ID);
        try {
          await ref.read();
          pastAnalysesContainerInstance = ref;
          return ref;
        } catch {
          /* not yet ready, continue polling */
        }
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  throw new Error(
    `CosmosDB container '${COSMOS_PAST_ANALYSES_CONTAINER_ID}' not initialized after ${maxRetries} attempts`
  );
}

/**
 * Persist a past-analysis doc. Validates the payload via Zod first so a
 * malformed write is caught here rather than producing a confusing Cosmos
 * error response. Uses upsert so a turn replay overwrites cleanly (id is
 * deterministic: `${sessionId}__${turnId}`).
 *
 * Fire-and-forget callers should wrap this in try/catch — this function does
 * not swallow errors itself; the caller decides whether to log or retry.
 */
export async function upsertPastAnalysisDoc(
  doc: PastAnalysisDoc
): Promise<void> {
  const parsed = pastAnalysisDocSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `Invalid PastAnalysisDoc — refusing to write: ${parsed.error.message}`
    );
  }
  // Wave A3 · Serialise upserts against concurrent patch RMWs for the
  // same doc. The patch helpers below read-then-upsert; without this
  // lock, a late upsert (e.g. cache invalidation re-write) can clobber a
  // patch that already merged its field in.
  await withPastAnalysisDocLock(parsed.data.id, () =>
    upsertPastAnalysisDocUnlocked(parsed.data)
  );
}

/**
 * Wave A3 · Internal: the actual Cosmos upsert. Skips the per-doc lock so
 * the patch helpers below — which ALREADY hold the lock — can call this
 * without deadlocking. Schema validation is the caller's responsibility
 * for this entry point (the public `upsertPastAnalysisDoc` does it).
 */
async function upsertPastAnalysisDocUnlocked(
  doc: PastAnalysisDoc
): Promise<void> {
  const container = await waitForPastAnalysesContainer();
  await container.items.upsert(doc);
}

/**
 * Read by composite (sessionId, id). Used by feedback updates (W5.5) and the
 * exact-match cache lookup (W5.2).
 */
export async function getPastAnalysisDoc(
  sessionId: string,
  id: string
): Promise<PastAnalysisDoc | null> {
  const container = await waitForPastAnalysesContainer();
  try {
    const { resource } = await container.item(id, sessionId).read<PastAnalysisDoc>();
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}

/**
 * Patch the `feedback` field. Used by the thumbs UI route (W5.5). Returns the
 * resulting doc or `null` if the row no longer exists. Best-effort — does not
 * retry; the caller surface (an HTTP route) can.
 *
 * `target` (optional): when set, the granular feedback is upserted into the
 * `feedbackDetails[]` array keyed by `(target.type, target.id)`. When the
 * target is `{type:"answer", id:"answer"}`, the top-level fields are also
 * mirrored so the AI Search index merge keeps surfacing answer-level sentiment.
 * When `target` is omitted, this is the legacy answer-level write path: the
 * top-level fields are updated and the `feedbackDetails` "answer" entry is
 * mirrored too (so reads of either shape stay consistent).
 */
export async function setPastAnalysisFeedback(
  sessionId: string,
  id: string,
  feedback: PastAnalysisDoc["feedback"],
  // W9 · structured reasons + optional comment. Both default to clearing the
  // existing values when the user retracts a vote (feedback === "none") or
  // up-votes after a previous down-vote.
  reasons: PastAnalysisDoc["feedbackReasons"] = [],
  comment?: string,
  target?: PastAnalysisFeedbackTarget
): Promise<PastAnalysisDoc | null> {
  const container = await waitForPastAnalysesContainer();
  const trimmedComment = comment?.trim().slice(0, 500) ?? null;
  const effectiveTarget: PastAnalysisFeedbackTarget = target ?? {
    type: "answer",
    id: "answer",
  };

  // Wave A3 · Hold the per-doc lock so a concurrent BAI / pivot upsert
  // can't clobber the feedback field. Pre-A3 this comment said
  // "writes to a single row are not contended, so last-writer-wins is
  // acceptable" — that was true before BAI's late-arriving fire-and-forget
  // upsert path landed. Now feedback PATCH and BAI upsert both target the
  // same doc and an interleaved upsert overwrites the patched fields.
  return withPastAnalysisDocLock(id, async () => {
    return doSetPastAnalysisFeedback({
      container,
      sessionId,
      id,
      feedback,
      reasons,
      trimmedComment,
      effectiveTarget,
    });
  });
}

async function doSetPastAnalysisFeedback(args: {
  container: Container;
  sessionId: string;
  id: string;
  feedback: PastAnalysisDoc["feedback"];
  reasons: PastAnalysisDoc["feedbackReasons"];
  trimmedComment: string | null;
  effectiveTarget: PastAnalysisFeedbackTarget;
}): Promise<PastAnalysisDoc | null> {
  const { container, sessionId, id, feedback, reasons, trimmedComment, effectiveTarget } = args;
  const existing = await getPastAnalysisDoc(sessionId, id);
  if (!existing) return null;

  const prevDetails: PastAnalysisFeedbackDetail[] = existing.feedbackDetails ?? [];
  const now = Date.now();
  const filteredDetails = prevDetails.filter(
    (d) => !(d.target.type === effectiveTarget.type && d.target.id === effectiveTarget.id)
  );
  const newDetail: PastAnalysisFeedbackDetail = {
    target: effectiveTarget,
    feedback,
    reasons,
    comment: trimmedComment,
    createdAt:
      prevDetails.find(
        (d) => d.target.type === effectiveTarget.type && d.target.id === effectiveTarget.id
      )?.createdAt ?? now,
    updatedAt: now,
  };
  const nextDetails = [...filteredDetails, newDetail];

  const ops: Array<{ op: "set"; path: string; value: unknown }> = [
    { op: "set", path: "/feedbackDetails", value: nextDetails },
  ];

  // Mirror the "answer" target onto the top-level fields so the AI Search
  // index merge (mergeFeedbackInPastAnalysisIndex) keeps working unchanged.
  if (effectiveTarget.type === "answer" && effectiveTarget.id === "answer") {
    ops.push(
      { op: "set", path: "/feedback", value: feedback },
      { op: "set", path: "/feedbackReasons", value: reasons },
      { op: "set", path: "/feedbackComment", value: trimmedComment }
    );
  }

  try {
    const { resource } = await container.item(id, sessionId).patch<PastAnalysisDoc>({
      operations: ops,
    });
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}

/**
 * AMR2 · Patch the post-verifier business actions onto an existing past-
 * analysis row. The `maybeWritePastAnalysisDoc` fire-and-forget write fires
 * before `businessActionsPromise` resolves, so this attaches them in a
 * second pass — mirroring the chat-message-side `patchAssistantBusinessActions`
 * pattern. Read-modify-upsert (the array isn't Cosmos-native-patchable here).
 * Best-effort: returns `{ ok: false }` instead of throwing so the SSE branch
 * stays resilient. The corresponding doc is identified by deterministic
 * `${sessionId}__${turnId}` id.
 */
export async function patchPastAnalysisBusinessActions(params: {
  sessionId: string;
  turnId: string;
  items: BusinessActionItem[];
}): Promise<{ ok: boolean; reason?: string }> {
  if (!params.items.length) return { ok: false, reason: "empty" };
  const id = `${params.sessionId}__${params.turnId}`;
  return withPastAnalysisDocLock(id, async () => {
    try {
      const existing = await getPastAnalysisDoc(params.sessionId, id);
      if (!existing) return { ok: false, reason: "not_found" };
      const next: PastAnalysisDoc = {
        ...existing,
        businessActions: params.items.slice(0, 8),
      };
      // Wave A3 · The lock-bearing variant of the upsert avoids a
      // recursive lock acquisition (which would deadlock the chain).
      // Schema validation is performed inside the wrapper.
      const parsed = pastAnalysisDocSchema.safeParse(next);
      if (!parsed.success) {
        return { ok: false, reason: `invalid_doc: ${parsed.error.message}` };
      }
      await upsertPastAnalysisDocUnlocked(parsed.data);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg };
    }
  });
}

/**
 * AMR3 · Patch the pivot artifacts emitted during the turn onto the past-
 * analysis row. Used by the chatStream service after the agent loop's
 * `pivotArtifactsBuffer` is materialized (inline or blob-offloaded) so a
 * future cache-hit can restore the rich pivot UI without re-running the
 * underlying query. Same read-modify-upsert pattern as the business actions
 * patch above.
 */
export async function patchPastAnalysisPivotArtifacts(params: {
  sessionId: string;
  turnId: string;
  artifacts: PastAnalysisPivotArtifact[];
}): Promise<{ ok: boolean; reason?: string }> {
  if (!params.artifacts.length) return { ok: false, reason: "empty" };
  const id = `${params.sessionId}__${params.turnId}`;
  return withPastAnalysisDocLock(id, async () => {
    try {
      const existing = await getPastAnalysisDoc(params.sessionId, id);
      if (!existing) return { ok: false, reason: "not_found" };
      const next: PastAnalysisDoc = {
        ...existing,
        pivotArtifacts: params.artifacts.slice(0, 12),
      };
      const parsed = pastAnalysisDocSchema.safeParse(next);
      if (!parsed.success) {
        return { ok: false, reason: `invalid_doc: ${parsed.error.message}` };
      }
      await upsertPastAnalysisDocUnlocked(parsed.data);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg };
    }
  });
}

/**
 * Query a session's recent past-analysis docs newest-first, capped to `limit`.
 * Used by the W5.6 cleanup script and the upcoming admin dashboard (W6.4).
 */
export async function listPastAnalysesForSession(
  sessionId: string,
  limit = 50
): Promise<PastAnalysisDoc[]> {
  const container = await waitForPastAnalysesContainer();
  const { resources } = await container.items
    .query<PastAnalysisDoc>(
      {
        query: "SELECT * FROM c WHERE c.sessionId = @sid ORDER BY c.createdAt DESC OFFSET 0 LIMIT @lim",
        parameters: [
          { name: "@sid", value: sessionId },
          { name: "@lim", value: limit },
        ],
      },
      { partitionKey: sessionId }
    )
    .fetchAll();
  return resources;
}

/**
 * Cross-partition aggregation of feedback counts grouped by sessionId. Used
 * by the superadmin sessions list to render `▲ N / ▼ N / ◯ N` badges per
 * session without firing an N+1 query.
 *
 * Cost: one cross-partition query that returns one row per past-analysis
 * doc, projected to `(sessionId, feedback)`. We aggregate in memory.
 * Practical cap is the size of the past_analyses container — paginate if
 * this grows past tens of thousands.
 */
export async function aggregateFeedbackCountsBySession(): Promise<
  Map<string, { up: number; down: number; none: number }>
> {
  const container = await waitForPastAnalysesContainer();
  const { resources } = await container.items
    .query<{ sessionId: string; feedback: "up" | "down" | "none" }>(
      { query: "SELECT c.sessionId, c.feedback FROM c" },
      { enableCrossPartitionQuery: true }
    )
    .fetchAll();

  const out = new Map<string, { up: number; down: number; none: number }>();
  for (const row of resources) {
    const counts = out.get(row.sessionId) ?? { up: 0, down: 0, none: 0 };
    if (row.feedback === "up") counts.up += 1;
    else if (row.feedback === "down") counts.down += 1;
    else counts.none += 1;
    out.set(row.sessionId, counts);
  }
  return out;
}

/**
 * W5.4 / W5.6 · Find every past-analysis row that should no longer serve from
 * cache. Two retire reasons, both anti-stale:
 *   - older than `maxAgeMs` (default: 90 days) — TTL
 *   - older than the session's `keepLatestNVersions` most recent dataVersions
 *     (default: keep current and one prior)
 *
 * Returns rows for the caller to delete. Doing the read separate from the
 * delete keeps the SQL simple (Cosmos doesn't allow `DELETE`-shaped queries)
 * and lets the cleanup script log what it's about to remove for audit.
 */
export interface PurgeCandidatesQuery {
  /** Optional scope; null/undefined = all sessions. */
  sessionId?: string;
  /** Rows older than `Date.now() - maxAgeMs` are candidates. */
  maxAgeMs?: number;
  /** Per-session: keep this many of the latest dataVersions; older are candidates. */
  keepLatestNVersions?: number;
}

const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_KEEP_VERSIONS = 2;

export async function findPurgeCandidates(
  q: PurgeCandidatesQuery = {}
): Promise<Array<{ id: string; sessionId: string; dataVersion: number; createdAt: number }>> {
  const container = await waitForPastAnalysesContainer();
  const maxAgeMs = q.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const keepN = q.keepLatestNVersions ?? DEFAULT_KEEP_VERSIONS;
  const ageCutoff = Date.now() - maxAgeMs;

  // Pass 1: TTL — rows older than the cutoff are immediate candidates.
  const ageQuery = q.sessionId
    ? "SELECT c.id, c.sessionId, c.dataVersion, c.createdAt FROM c WHERE c.sessionId = @sid AND c.createdAt < @cut"
    : "SELECT c.id, c.sessionId, c.dataVersion, c.createdAt FROM c WHERE c.createdAt < @cut";
  const ageParams = q.sessionId
    ? [
        { name: "@sid", value: q.sessionId },
        { name: "@cut", value: ageCutoff },
      ]
    : [{ name: "@cut", value: ageCutoff }];
  const { resources: tooOld } = await container.items
    .query<{ id: string; sessionId: string; dataVersion: number; createdAt: number }>(
      { query: ageQuery, parameters: ageParams },
      { enableCrossPartitionQuery: !q.sessionId }
    )
    .fetchAll();

  // Pass 2: per-session, identify rows whose dataVersion is older than the top
  // `keepN` versions for that session and add them.
  const stalePerSession: typeof tooOld = [];
  const sessionIds = q.sessionId
    ? [q.sessionId]
    : Array.from(new Set(tooOld.map((d) => d.sessionId)));
  for (const sid of sessionIds) {
    const { resources } = await container.items
      .query<{ id: string; sessionId: string; dataVersion: number; createdAt: number }>(
        {
          query:
            "SELECT c.id, c.sessionId, c.dataVersion, c.createdAt FROM c WHERE c.sessionId = @sid",
          parameters: [{ name: "@sid", value: sid }],
        },
        { partitionKey: sid }
      )
      .fetchAll();
    if (resources.length === 0) continue;
    const versions = Array.from(new Set(resources.map((d) => d.dataVersion))).sort(
      (a, b) => b - a
    );
    const keepSet = new Set(versions.slice(0, keepN));
    for (const r of resources) {
      if (!keepSet.has(r.dataVersion)) stalePerSession.push(r);
    }
  }

  // Dedupe by id across both passes.
  const seen = new Set<string>();
  const out: typeof tooOld = [];
  for (const c of [...tooOld, ...stalePerSession]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** Delete a single past-analysis row from Cosmos. */
export async function deletePastAnalysisDoc(
  sessionId: string,
  id: string
): Promise<void> {
  const container = await waitForPastAnalysesContainer();
  try {
    await container.item(id, sessionId).delete();
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return; // already gone
    throw err;
  }
}
