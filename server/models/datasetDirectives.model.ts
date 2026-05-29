/**
 * Wave W-UD2 · `dataset_directives` Cosmos container model.
 *
 * Authoritative store for `UserDirective` records, keyed by
 * `(username, datasetFingerprint)`. Every chat session whose dataset shape
 * shares a fingerprint hydrates the active directives from this one doc.
 *
 * The Cosmos doc id format is `${username}__${datasetFingerprint}`. Partition
 * key is `/username`. Schema is `datasetDirectivesDocSchema` (see
 * [shared/schema.ts](../shared/schema.js)).
 *
 * Writes are serialised through `withSessionWriteLock` (Wave A2) on a
 * synthetic key — see `lockKey()` below — so concurrent updates from two
 * sessions on the same dataset shape do not race. Single-instance correctness
 * only, matching invariant #9 in CLAUDE.md.
 */
import { randomBytes } from "crypto";
import { waitForDatasetDirectivesContainer } from "./database.config.js";
import { withSessionWriteLock } from "../lib/sessionWriteLock.js";
import {
  datasetDirectivesDocSchema,
  type DatasetDirectivesDoc,
  type UserDirective,
  type UserDirectiveScope,
  type UserDirectiveKind,
  type UserDirectiveSource,
  type UserDirectiveStructured,
} from "../shared/schema.js";

const DOC_ID_SEPARATOR = "__";

/** Test-only container injection. When set, `getContainerForOps` returns this
 *  instead of calling `waitForDatasetDirectivesContainer`. Production never
 *  touches this. See `__setContainerForTesting`. */
let testContainerOverride: {
  item: (id: string, partitionKey: string) => {
    read: <T>() => Promise<{ resource: T | undefined }>;
  };
  items: { upsert: (doc: unknown) => Promise<unknown> };
} | null = null;

async function getContainerForOps() {
  if (testContainerOverride) return testContainerOverride as any;
  return waitForDatasetDirectivesContainer();
}

/** Cosmos doc id for a (user, dataset) pair. */
function docIdFor(username: string, fingerprint: string): string {
  return `${normaliseUsername(username)}${DOC_ID_SEPARATOR}${fingerprint}`;
}

/** Write-lock key — different scope from session-level locks. */
function lockKey(username: string, fingerprint: string): string {
  return `dataset_directives::${normaliseUsername(username)}::${fingerprint}`;
}

function normaliseUsername(value: string): string {
  return (value ?? "").trim().toLowerCase();
}

/** Compact directive id: 26 chars, sortable by leading timestamp. */
function generateDirectiveId(): string {
  const ts = Date.now().toString(36).padStart(8, "0").slice(0, 8);
  const rand = randomBytes(9).toString("hex").slice(0, 18);
  return `${ts}-${rand}`;
}

/** Empty doc shape — used when no prior directives exist for this dataset. */
function emptyDoc(username: string, fingerprint: string): DatasetDirectivesDoc {
  return {
    id: docIdFor(username, fingerprint),
    username: normaliseUsername(username),
    datasetFingerprint: fingerprint,
    directives: [],
    version: 0,
    updatedAt: Date.now(),
  };
}

/**
 * Read the directives doc for `(username, fingerprint)`. Returns the empty
 * shape (not persisted) when no record exists yet — callers can mutate and
 * pass it back through `writeDoc` to materialise it on first write.
 */
export async function getDatasetDirectivesDoc(
  username: string,
  fingerprint: string
): Promise<DatasetDirectivesDoc> {
  const container = await getContainerForOps();
  const id = docIdFor(username, fingerprint);
  const partition = normaliseUsername(username);
  try {
    const { resource } = await container.item(id, partition).read();
    if (!resource) return emptyDoc(username, fingerprint);
    const parsed = datasetDirectivesDocSchema.safeParse(resource);
    if (!parsed.success) {
      console.warn(
        `⚠️ dataset_directives doc ${id} failed schema parse; returning empty`,
        parsed.error.issues.slice(0, 3)
      );
      return emptyDoc(username, fingerprint);
    }
    return parsed.data;
  } catch (err: any) {
    // 404 = not yet created; treat as empty
    if (err?.code === 404) return emptyDoc(username, fingerprint);
    throw err;
  }
}

/** Active directives only — filter applied at read time. */
export async function listActiveDirectives(
  username: string,
  fingerprint: string
): Promise<UserDirective[]> {
  const doc = await getDatasetDirectivesDoc(username, fingerprint);
  return doc.directives.filter((d) => d.status === "active");
}

/**
 * Wave W-UD6 · convenience for chat-pipeline callers: fetch the active
 * directive list for a session, returning `[]` (not throwing) on any error.
 * Safe to call from inside `chatStream.service.ts`'s `kickOffPreClassifyWork`
 * thunk-style helpers — a directives-store outage must never block a chat
 * turn. The agent simply runs without persistent directives.
 */
export async function hydrateDirectivesForSession(
  username: string | undefined,
  datasetFingerprint: string | undefined
): Promise<UserDirective[]> {
  if (!username || !datasetFingerprint) return [];
  try {
    return await listActiveDirectives(username, datasetFingerprint);
  } catch (e) {
    console.warn("⚠️ hydrateDirectivesForSession failed (returning []):", e);
    return [];
  }
}

/** Internal: upsert the doc with version + updatedAt bumped. */
async function writeDoc(doc: DatasetDirectivesDoc): Promise<DatasetDirectivesDoc> {
  const container = await getContainerForOps();
  const next: DatasetDirectivesDoc = {
    ...doc,
    version: doc.version + 1,
    updatedAt: Date.now(),
  };
  await container.items.upsert(next);
  return next;
}

/** Input for `appendDirective`. Everything except id / status / addedAt is
 *  caller-supplied; the model fills in lifecycle fields. */
export interface DirectiveDraft {
  scope?: UserDirectiveScope;
  kind: UserDirectiveKind;
  text: string;
  structured?: UserDirectiveStructured;
  source: UserDirectiveSource;
  sourceSessionId?: string;
  sourceTurnId?: string;
  /** Ids of currently-active directives this draft is meant to override.
   *  Each will be transitioned to `status: 'superseded'` with `supersededBy`
   *  set to the new directive's id. */
  supersedes?: string[];
}

/**
 * Append a new directive to the dataset's store. When `draft.supersedes`
 * names existing active directives, they are transitioned to `superseded`
 * in the same write (audit-preserving). Returns the persisted directive.
 *
 * Concurrency-safe: acquires the (username, fingerprint) write lock, so
 * two concurrent appends from different sessions serialise.
 */
export async function appendDirective(
  username: string,
  fingerprint: string,
  draft: DirectiveDraft
): Promise<{ doc: DatasetDirectivesDoc; directive: UserDirective }> {
  return withSessionWriteLock(lockKey(username, fingerprint), async () => {
    const doc = await getDatasetDirectivesDoc(username, fingerprint);
    const newDirective: UserDirective = {
      id: generateDirectiveId(),
      scope: draft.scope ?? "dataset",
      kind: draft.kind,
      text: draft.text,
      structured: draft.structured,
      source: draft.source,
      sourceSessionId: draft.sourceSessionId,
      sourceTurnId: draft.sourceTurnId,
      addedAt: Date.now(),
      status: "active",
      supersedes: draft.supersedes && draft.supersedes.length > 0
        ? Array.from(new Set(draft.supersedes))
        : undefined,
    };
    const supersedeSet = new Set(draft.supersedes ?? []);
    const updatedDirectives = doc.directives.map((d) =>
      supersedeSet.has(d.id) && d.status === "active"
        ? { ...d, status: "superseded" as const, supersededBy: newDirective.id }
        : d
    );
    updatedDirectives.push(newDirective);
    const persisted = await writeDoc({ ...doc, directives: updatedDirectives });
    return { doc: persisted, directive: newDirective };
  });
}

/**
 * Revoke a directive (user clicked Revoke in the UI). Transitions its
 * status to `revoked`. Returns the updated doc, or null if the id is not
 * found / already revoked.
 */
export async function revokeDirective(
  username: string,
  fingerprint: string,
  directiveId: string
): Promise<DatasetDirectivesDoc | null> {
  return withSessionWriteLock(lockKey(username, fingerprint), async () => {
    const doc = await getDatasetDirectivesDoc(username, fingerprint);
    let mutated = false;
    const updated = doc.directives.map((d) => {
      if (d.id !== directiveId) return d;
      if (d.status === "revoked") return d;
      mutated = true;
      return { ...d, status: "revoked" as const };
    });
    if (!mutated) return null;
    return writeDoc({ ...doc, directives: updated });
  });
}

// ---------------------------------------------------------------------------
// Test-only escape hatches
// ---------------------------------------------------------------------------

/** Test-only — exposes the lock key for assertion. */
export function __lockKeyForTesting(username: string, fingerprint: string): string {
  return lockKey(username, fingerprint);
}

/** Test-only — exposes the directive id format. */
export function __generateDirectiveIdForTesting(): string {
  return generateDirectiveId();
}

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
