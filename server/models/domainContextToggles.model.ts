/**
 * WD5 · Cosmos toggle store for domain context packs.
 *
 * Single-document model. One doc with `id = "global"` holds the per-pack
 * enabled/disabled overrides. Defaults come from the pack frontmatter
 * (`enabledByDefault`); the doc only stores explicit admin overrides.
 *
 * Atomic concurrent writes via etag-guarded `replace`. If two admins toggle
 * different packs at the same moment, the second write retries on 412
 * (precondition failed) — see `setPackEnabled`.
 *
 * Cosmos cold / unconfigured → return `{}` and log once. The chat path is
 * never blocked on toggle-store availability — defaults still apply.
 */

import type { Container, ItemDefinition } from "@azure/cosmos";
import { getDatabase, initializeCosmosDB } from "./database.config.js";

export const COSMOS_DOMAIN_CONTEXT_TOGGLES_CONTAINER_ID =
  process.env.COSMOS_DOMAIN_CONTEXT_TOGGLES_CONTAINER_ID || "domain_context_toggles";

const SINGLETON_ID = "global";
const SINGLETON_PARTITION = "global";
const AUDIT_LOG_MAX = 50;

export interface DomainContextToggleAuditEntry {
  packId: string;
  prev: boolean;
  next: boolean;
  by: string;
  at: number;
}

export interface DomainContextTogglesDoc extends ItemDefinition {
  id: string;
  partitionKey: string;
  overrides: Record<string, boolean>;
  auditLog: DomainContextToggleAuditEntry[];
  updatedAt: number;
  updatedBy: string;
}

let containerInstance: Container | null = null;
let unconfiguredWarned = false;

async function getContainer(): Promise<Container | null> {
  if (containerInstance) return containerInstance;
  try {
    await initializeCosmosDB();
  } catch {
    /* fall through */
  }
  const db = getDatabase();
  if (!db) {
    if (!unconfiguredWarned) {
      console.warn(
        `domainContextToggles: Cosmos not configured — using frontmatter defaults only`
      );
      unconfiguredWarned = true;
    }
    return null;
  }
  try {
    const { container } = await db.containers.createIfNotExists({
      id: COSMOS_DOMAIN_CONTEXT_TOGGLES_CONTAINER_ID,
      partitionKey: "/partitionKey",
    });
    containerInstance = container;
    return container;
  } catch {
    try {
      const ref = db.container(COSMOS_DOMAIN_CONTEXT_TOGGLES_CONTAINER_ID);
      await ref.read();
      containerInstance = ref;
      return ref;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`domainContextToggles: container init failed (${msg})`);
      return null;
    }
  }
}

function emptyDoc(): DomainContextTogglesDoc {
  return {
    id: SINGLETON_ID,
    partitionKey: SINGLETON_PARTITION,
    overrides: {},
    auditLog: [],
    updatedAt: 0,
    updatedBy: "",
  };
}

async function readDoc(container: Container): Promise<DomainContextTogglesDoc | null> {
  try {
    const { resource } = await container
      .item(SINGLETON_ID, SINGLETON_PARTITION)
      .read<DomainContextTogglesDoc>();
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number })?.code
      ?? (err as { statusCode?: number })?.statusCode;
    if (code === 404) return null;
    throw err;
  }
}

/**
 * Read current overrides. Defaults to {} if the doc doesn't exist or Cosmos
 * isn't configured. Never throws on the happy or empty paths.
 */
export async function getToggleOverrides(): Promise<Record<string, boolean>> {
  const container = await getContainer();
  if (!container) return {};
  try {
    const doc = await readDoc(container);
    return doc?.overrides ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`domainContextToggles: read failed (${msg}) — falling back to defaults`);
    return {};
  }
}

/**
 * Set a single pack's override. Etag-guarded read → mutate → replace, retried
 * once on 412 (concurrent admin write). Returns the updated overrides map.
 */
export async function setPackEnabled(
  packId: string,
  enabled: boolean,
  byEmail: string
): Promise<Record<string, boolean>> {
  const container = await getContainer();
  if (!container) {
    throw new Error("domain_context_toggles store unavailable (Cosmos not configured)");
  }

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existing = await readDoc(container);
    const doc = existing ?? emptyDoc();
    const prev = doc.overrides[packId] ?? null;
    if (prev === enabled) return doc.overrides;

    doc.overrides = { ...doc.overrides, [packId]: enabled };
    doc.auditLog = [
      ...doc.auditLog,
      { packId, prev: prev ?? !enabled, next: enabled, by: byEmail, at: Date.now() },
    ].slice(-AUDIT_LOG_MAX);
    doc.updatedAt = Date.now();
    doc.updatedBy = byEmail;

    try {
      if (existing && (existing as ItemDefinition)._etag) {
        const etag = (existing as ItemDefinition)._etag as string;
        const { resource } = await container
          .item(SINGLETON_ID, SINGLETON_PARTITION)
          .replace(doc, { accessCondition: { type: "IfMatch", condition: etag } });
        if (resource) return resource.overrides;
      } else {
        const { resource } = await container.items.upsert<DomainContextTogglesDoc>(doc);
        if (resource) return resource.overrides;
      }
      return doc.overrides;
    } catch (err) {
      const code = (err as { code?: number; statusCode?: number })?.code
        ?? (err as { statusCode?: number })?.statusCode;
      if (code === 412 && attempt < maxAttempts - 1) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`setPackEnabled: failed after ${maxAttempts} attempts (concurrent writes)`);
}

/** Test-only — drop the cached container handle and the warn-once flag. */
export function resetForTest(): void {
  containerInstance = null;
  unconfiguredWarned = false;
}
