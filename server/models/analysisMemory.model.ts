/**
 * W56 · Cosmos model for the `analysis_memory` container.
 *
 * Append-only per-session journal. Every analytical event (question, hypothesis,
 * finding, chart, computed column, filter, dashboard, data-op, user note,
 * conclusion) is a single immutable document partitioned by `/sessionId`. The
 * chat doc keeps the live state; this container is the durable, semantically-
 * retrievable, user-browsable projection that powers the Memory page (W62) and
 * the agent's semantic recall block (W60).
 *
 * Lazy container init mirrors `pastAnalysis.model.ts`: a Cosmos hiccup at boot
 * cannot block the agent loop — the first write that needs the container creates
 * it on demand.
 */
import { Container, type SqlParameter } from "@azure/cosmos";
import { getDatabase, initializeCosmosDB } from "./database.config.js";
import {
  analysisMemoryEntrySchema,
  type AnalysisMemoryEntry,
  type AnalysisMemoryEntryType,
} from "../shared/schema.js";

export const COSMOS_ANALYSIS_MEMORY_CONTAINER_ID =
  process.env.COSMOS_ANALYSIS_MEMORY_CONTAINER_ID || "analysis_memory";

let analysisMemoryContainerInstance: Container | null = null;

export async function waitForAnalysisMemoryContainer(
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Container> {
  if (analysisMemoryContainerInstance) return analysisMemoryContainerInstance;

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
          id: COSMOS_ANALYSIS_MEMORY_CONTAINER_ID,
          partitionKey: "/sessionId",
        });
        analysisMemoryContainerInstance = container;
        return container;
      } catch {
        const ref = db.container(COSMOS_ANALYSIS_MEMORY_CONTAINER_ID);
        try {
          await ref.read();
          analysisMemoryContainerInstance = ref;
          return ref;
        } catch {
          /* not yet ready */
        }
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  throw new Error(
    `CosmosDB container '${COSMOS_ANALYSIS_MEMORY_CONTAINER_ID}' not initialized after ${maxRetries} attempts`
  );
}

/**
 * Build a deterministic id so retries / replays upsert cleanly. The
 * `(sessionId, turnId, type, sequence)` tuple is the natural unique key.
 */
export function buildMemoryEntryId(
  sessionId: string,
  type: AnalysisMemoryEntryType,
  sequence: number,
  turnId?: string
): string {
  const turnPart = turnId ?? "lifecycle";
  return `${sessionId}__${turnPart}__${type}__${sequence}`;
}

/**
 * Validate + upsert a batch of entries into the same container partition.
 * Cosmos has no true bulk transaction across items, but per-partition
 * `bulk: true` operations execute concurrently and are idempotent under upsert.
 * Caller wraps in try/catch — this throws on validation failure so producers
 * notice when they are emitting malformed entries.
 */
export async function appendMemoryEntries(
  entries: AnalysisMemoryEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  const validated: AnalysisMemoryEntry[] = [];
  for (const e of entries) {
    const parsed = analysisMemoryEntrySchema.safeParse(e);
    if (!parsed.success) {
      throw new Error(
        `Invalid AnalysisMemoryEntry — refusing to write: ${parsed.error.message}`
      );
    }
    validated.push(parsed.data);
  }
  const container = await waitForAnalysisMemoryContainer();
  await Promise.all(validated.map((doc) => container.items.upsert(doc)));
}

export interface ListMemoryOptions {
  /** Filter by entry type(s). */
  types?: AnalysisMemoryEntryType[];
  /** Inclusive lower bound on createdAt (ms epoch). */
  since?: number;
  /** Cursor: skip entries created strictly before this createdAt. */
  cursorCreatedAt?: number;
  /** Page size; defaults to 100, max 500. */
  limit?: number;
}

export async function listMemoryEntries(
  sessionId: string,
  opts: ListMemoryOptions = {}
): Promise<AnalysisMemoryEntry[]> {
  const container = await waitForAnalysisMemoryContainer();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const params: SqlParameter[] = [
    { name: "@sid", value: sessionId },
    { name: "@lim", value: limit },
  ];
  let where = "c.sessionId = @sid";
  if (opts.since !== undefined) {
    where += " AND c.createdAt >= @since";
    params.push({ name: "@since", value: opts.since });
  }
  if (opts.cursorCreatedAt !== undefined) {
    where += " AND c.createdAt < @cursor";
    params.push({ name: "@cursor", value: opts.cursorCreatedAt });
  }
  if (opts.types && opts.types.length > 0) {
    where +=
      " AND ARRAY_CONTAINS(@types, c.type)";
    params.push({ name: "@types", value: opts.types });
  }
  const { resources } = await container.items
    .query<AnalysisMemoryEntry>(
      {
        query: `SELECT * FROM c WHERE ${where} ORDER BY c.createdAt ASC OFFSET 0 LIMIT @lim`,
        parameters: params,
      },
      { partitionKey: sessionId }
    )
    .fetchAll();
  return resources;
}

export async function getMemoryEntry(
  sessionId: string,
  id: string
): Promise<AnalysisMemoryEntry | null> {
  const container = await waitForAnalysisMemoryContainer();
  try {
    const { resource } = await container
      .item(id, sessionId)
      .read<AnalysisMemoryEntry>();
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}

export async function countMemoryEntries(sessionId: string): Promise<number> {
  const container = await waitForAnalysisMemoryContainer();
  const { resources } = await container.items
    .query<{ n: number }>(
      {
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.sessionId = @sid",
        parameters: [{ name: "@sid", value: sessionId }],
      },
      { partitionKey: sessionId }
    )
    .fetchAll();
  const first = resources[0];
  return typeof first === "number" ? first : 0;
}
