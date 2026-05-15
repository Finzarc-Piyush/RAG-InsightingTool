/**
 * Wave AD3 · Cosmos model for the `usage_events` container.
 *
 * Append-only event log for admin-dashboard observability. One row per
 * occurrence; partition key is `/dateKey` (UTC `YYYYMMDD`) so daily-grain
 * aggregation queries are cheap.
 *
 * Lazy container init mirrors `pastAnalysis.model.ts` so a Cosmos hiccup at
 * boot can never block the live request path.
 */

import { Container, type SqlParameter } from "@azure/cosmos";
import { randomUUID } from "node:crypto";
import { getDatabase, initializeCosmosDB } from "./database.config.js";
import {
  usageEventDocSchema,
  type UsageEventDoc,
  type UsageEventType,
} from "../shared/schema.js";

export const COSMOS_USAGE_EVENTS_CONTAINER_ID =
  process.env.COSMOS_USAGE_EVENTS_CONTAINER_ID || "usage_events";

let usageEventsContainerInstance: Container | null = null;

/** Lazily resolve (and create on first call) the `usage_events` container. */
export async function waitForUsageEventsContainer(
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Container> {
  if (usageEventsContainerInstance) return usageEventsContainerInstance;

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
          id: COSMOS_USAGE_EVENTS_CONTAINER_ID,
          partitionKey: "/dateKey",
        });
        usageEventsContainerInstance = container;
        return container;
      } catch {
        const ref = db.container(COSMOS_USAGE_EVENTS_CONTAINER_ID);
        try {
          await ref.read();
          usageEventsContainerInstance = ref;
          return ref;
        } catch {
          /* not yet ready, continue polling */
        }
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  throw new Error(
    `CosmosDB container '${COSMOS_USAGE_EVENTS_CONTAINER_ID}' not initialized after ${maxRetries} attempts`
  );
}

/** Convert a ms-epoch timestamp into the UTC dateKey used as partition. */
export function dateKeyFromTimestamp(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export interface RecordUsageEventInput {
  eventType: UsageEventType;
  userEmail: string;
  sessionId?: string;
  dashboardId?: string;
  metadata?: Record<string, unknown>;
  /** Override the default `Date.now()` — only used in tests / replay. */
  timestamp?: number;
}

/**
 * Fire-and-forget writer. NEVER throws — telemetry must not break user
 * requests. Failures log a warning; missing Cosmos config is silently
 * skipped (so dev / DISABLE_AUTH workflows don't spam warnings).
 */
export async function recordUsageEvent(
  input: RecordUsageEventInput
): Promise<void> {
  if (process.env.USAGE_EVENTS_ENABLED === "false") return;
  const userEmail = input.userEmail?.trim().toLowerCase();
  if (!userEmail) return; // nothing to attribute against
  const ts = input.timestamp ?? Date.now();
  const dateKey = dateKeyFromTimestamp(ts);
  const doc: UsageEventDoc = {
    id: `${dateKey}__${userEmail}__${input.eventType}__${randomUUID()}`,
    dateKey,
    timestamp: ts,
    eventType: input.eventType,
    userEmail,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.dashboardId ? { dashboardId: input.dashboardId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const parsed = usageEventDocSchema.safeParse(doc);
  if (!parsed.success) {
    console.warn(
      `⚠️ recordUsageEvent · refusing malformed doc (${input.eventType}): ${parsed.error.message}`
    );
    return;
  }
  try {
    const container = await waitForUsageEventsContainer(4, 250);
    await container.items.create(parsed.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠️ recordUsageEvent · ${input.eventType} write failed (${msg}); event dropped`
    );
  }
}

export interface UsageEventQuery {
  /** UTC YYYYMMDD inclusive. */
  fromDateKey: string;
  /** UTC YYYYMMDD inclusive. */
  toDateKey: string;
  eventType?: UsageEventType;
  userEmail?: string;
  /** Cap on rows returned. */
  limit?: number;
}

/**
 * Cross-partition query for the metrics aggregator (Wave AD5). Fetches every
 * event in the date range optionally filtered by type / user. The result is
 * intended to be aggregated client-side (in-process) — for large windows the
 * caller should rely on the metricsCache 60s TTL to amortise the round-trip.
 */
export async function listUsageEvents(
  q: UsageEventQuery
): Promise<UsageEventDoc[]> {
  const container = await waitForUsageEventsContainer();
  const conditions: string[] = ["c.dateKey >= @from", "c.dateKey <= @to"];
  const params: SqlParameter[] = [
    { name: "@from", value: q.fromDateKey },
    { name: "@to", value: q.toDateKey },
  ];
  if (q.eventType) {
    conditions.push("c.eventType = @eventType");
    params.push({ name: "@eventType", value: q.eventType });
  }
  if (q.userEmail) {
    conditions.push("c.userEmail = @user");
    params.push({ name: "@user", value: q.userEmail.toLowerCase() });
  }
  const limit = Math.max(1, Math.min(q.limit ?? 50_000, 200_000));
  const sql = `SELECT TOP ${limit} * FROM c WHERE ${conditions.join(" AND ")} ORDER BY c.timestamp ASC`;
  const { resources } = await container.items
    .query<UsageEventDoc>({ query: sql, parameters: params }, { partitionKey: undefined })
    .fetchAll();
  return resources;
}
