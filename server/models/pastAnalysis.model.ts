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
 */
export async function setPastAnalysisFeedback(
  sessionId: string,
  id: string,
  feedback: PastAnalysisDoc["feedback"],
  // W9 · structured reasons + optional comment. Both default to clearing the
  // existing values when the user retracts a vote (feedback === "none") or
  // up-votes after a previous down-vote.
  reasons: PastAnalysisDoc["feedbackReasons"] = [],
  comment?: string
): Promise<PastAnalysisDoc | null> {
  const container = await waitForPastAnalysesContainer();
  try {
    const trimmedComment = comment?.trim().slice(0, 500);
    const { resource } = await container.item(id, sessionId).patch<PastAnalysisDoc>({
      operations: [
        { op: "set", path: "/feedback", value: feedback },
        { op: "set", path: "/feedbackReasons", value: reasons },
        // Always set the comment field (to either the new value or undefined)
        // so a retraction clears any stale free-text from a prior down-vote.
        { op: "set", path: "/feedbackComment", value: trimmedComment ?? null },
      ],
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
