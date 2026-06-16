/**
 * Wave W-DPC1 · `dataset_profiles` Cosmos cache model.
 *
 * The upload-critical-path `inferDatasetProfile` LLM call (~15-20s) is the
 * dominant cause of the upload→first-question delay. This cache lets a
 * re-upload of the SAME workbook shape skip that call entirely.
 *
 * Key: doc id `${username}__${datasetFingerprint}`, partition `/username`
 * (mirrors [datasetDirectives.model.ts](./datasetDirectives.model.js)). A
 * `contextHash` field captures the permanent + domain context that also feed
 * the profile, so a context change invalidates the entry. `schemaVersion`
 * invalidates EVERY entry when the profile prompt / `DatasetProfile` shape
 * changes — bump `DATASET_PROFILE_CACHE_SCHEMA_VERSION` whenever you edit
 * `SYSTEM_PROMPT` in `datasetProfile.ts` or `datasetProfileSchema`.
 *
 * Only the `DatasetProfile` object is cached — never the materialized table. A
 * cache HIT still runs the full `applyUploadPipelineWithProfile` on freshly
 * parsed data, so temporal facets / cleaning are unchanged.
 *
 * All reads/writes are best-effort: any Cosmos error (or a miss) returns
 * `null` / no-ops so a cache outage never blocks `enrichmentStatus='complete'`.
 * Two same-fingerprint datasets share an entry by design (same precedent as the
 * directives store): the profile classifies columns by name+type, which a
 * shared fingerprint already fixes.
 */
import { createHash } from "crypto";
import { waitForDatasetProfileCacheContainer } from "./database.config.js";
import {
  datasetProfileCacheDocSchema,
  type DatasetProfile,
} from "../shared/schema.js";
import { logger } from "../lib/logger.js";
import { errorMessage } from "../utils/errorMessage.js";

const DOC_ID_SEPARATOR = "__";

/** Bump whenever the profile prompt or `DatasetProfile` shape changes
 *  materially — older cache docs then read as a MISS and get recomputed. */
export const DATASET_PROFILE_CACHE_SCHEMA_VERSION = 1;

/** Test-only container injection. Production never touches this. */
let testContainerOverride: {
  item: (id: string, partitionKey: string) => {
    read: <T>() => Promise<{ resource: T | undefined }>;
  };
  items: { upsert: (doc: unknown) => Promise<unknown> };
} | null = null;

async function getContainerForOps() {
  if (testContainerOverride) return testContainerOverride as any;
  return waitForDatasetProfileCacheContainer();
}

function normaliseUsername(value: string): string {
  return (value ?? "").trim().toLowerCase();
}

function docIdFor(username: string, fingerprint: string): string {
  return `${normaliseUsername(username)}${DOC_ID_SEPARATOR}${fingerprint}`;
}

/**
 * 16-hex hash of the two free-text context blocks that feed the profile call.
 * Raw (untrimmed) inputs are hashed so ANY change invalidates — we don't
 * replicate the 800/2000-char caps applied inside `datasetProfile.ts`.
 */
export function computeContextHash(
  permanentContext?: string | null,
  domainContext?: string | null
): string {
  const canonical = `${(permanentContext ?? "").trim()}␟${(domainContext ?? "").trim()}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/**
 * Read the cached profile for `(username, fingerprint)`. Returns `null` on any
 * MISS: 404, schema-parse failure, `contextHash` mismatch, or `schemaVersion`
 * mismatch. Never throws — Cosmos errors collapse to `null` so callers fall
 * back to a live `inferDatasetProfile`.
 */
export async function readCachedProfile(
  username: string,
  fingerprint: string,
  contextHash: string
): Promise<DatasetProfile | null> {
  try {
    const container = await getContainerForOps();
    const id = docIdFor(username, fingerprint);
    const partition = normaliseUsername(username);
    const { resource } = await container.item(id, partition).read();
    if (!resource) return null;
    const parsed = datasetProfileCacheDocSchema.safeParse(resource);
    if (!parsed.success) return null;
    if (parsed.data.schemaVersion !== DATASET_PROFILE_CACHE_SCHEMA_VERSION) return null;
    if (parsed.data.contextHash !== contextHash) return null;
    return parsed.data.profile;
  } catch (err: unknown) {
    // Cosmos 404 = entry missing; `code` is a numeric Cosmos status here.
    if ((err as { code?: number })?.code === 404) return null;
    logger.warn("⚠️ readCachedProfile failed (treating as miss):", errorMessage(err));
    return null;
  }
}

/**
 * Upsert the cached profile. Best-effort: errors are swallowed (logged) so a
 * cache-store outage never blocks the upload. Callers should only write a
 * profile that actually came from the LLM (non-empty `shortDescription`) —
 * never the empty/timeout fallback.
 */
export async function writeCachedProfile(
  username: string,
  fingerprint: string,
  contextHash: string,
  profile: DatasetProfile
): Promise<void> {
  try {
    const container = await getContainerForOps();
    const doc = datasetProfileCacheDocSchema.parse({
      id: docIdFor(username, fingerprint),
      username: normaliseUsername(username),
      datasetFingerprint: fingerprint,
      contextHash,
      schemaVersion: DATASET_PROFILE_CACHE_SCHEMA_VERSION,
      profile,
      updatedAt: Date.now(),
    });
    await container.items.upsert(doc);
  } catch (err: unknown) {
    logger.warn("⚠️ writeCachedProfile failed (non-fatal):", errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Test-only escape hatches
// ---------------------------------------------------------------------------

/** Test-only — exposes the doc id format. */
export function __docIdForTesting(username: string, fingerprint: string): string {
  return docIdFor(username, fingerprint);
}

/** Test-only — install an in-memory Cosmos stub. Pass `null` to revert. */
export function __setContainerForTesting(
  stub:
    | {
        item: (id: string, partitionKey: string) => {
          read: <T>() => Promise<{ resource: T | undefined }>;
        };
        items: { upsert: (doc: unknown) => Promise<unknown> };
      }
    | null
): void {
  testContainerOverride = stub;
}
