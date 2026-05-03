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
} from "../shared/schema.js";

export const COSMOS_PAST_ANALYSES_CONTAINER_ID =
  process.env.COSMOS_PAST_ANALYSES_CONTAINER_ID || "past_analyses";

let pastAnalysesContainerInstance: Container | null = null;

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
  const container = await waitForPastAnalysesContainer();
  await container.items.upsert(parsed.data);
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

  // We need to read-modify-write to upsert into the feedbackDetails array
  // (Cosmos PATCH lacks a portable "upsert by key" array op). The doc is small
  // and writes to a single (sessionId, id) row are not contended, so the
  // last-writer-wins window is acceptable for thumbs feedback.
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
