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
 * sessions on the SAME instance do not race. Across instances, writes also
 * carry an optimistic-concurrency IfMatch `_etag` precondition: a stale write
 * (a writer on another serverless instance moved the doc out from under us,
 * where the in-process lock can't reach) throws Cosmos 412, which `writeDoc`'s
 * caller re-reads + re-applies + retries (bounded), mirroring
 * `mutateChatDocument` in [chat.model.ts](./chat.model.ts). See invariant #9.
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
import { logger } from "../lib/logger.js";

const DOC_ID_SEPARATOR = "__";

/** Bound on optimistic-concurrency (IfMatch `_etag`) retry attempts, mirroring
 *  `mutateChatDocument`'s default in chat.model.ts. */
const MAX_WRITE_RETRIES = 3;

/**
 * In-memory shape carrying the Cosmos `_etag` alongside the schema-validated
 * doc. `datasetDirectivesDocSchema` is a strict `z.object` (it strips unknown
 * keys), so the server-assigned `_etag` would be lost on parse — we capture it
 * from the raw resource and thread it through for IfMatch writes. The persisted
 * doc shape is unchanged; `_etag` is Cosmos-managed metadata, never written by
 * us. A freshly-created (never-persisted) empty doc has no `_etag`.
 */
type DatasetDirectivesDocWithEtag = DatasetDirectivesDoc & { _etag?: string };

/** True for a Cosmos 412 Precondition Failed (IfMatch `_etag` mismatch),
 *  matching `isPreconditionFailed` in chat.model.ts. */
function isPreconditionFailed(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number } | null;
  return e?.code === 412 || e?.statusCode === 412;
}

/** Test-only container injection. When set, `getContainerForOps` returns this
 *  instead of calling `waitForDatasetDirectivesContainer`. Production never
 *  touches this. See `__setContainerForTesting`. */
let testContainerOverride: {
  item: (id: string, partitionKey: string) => {
    read: <T>() => Promise<{ resource: T | undefined }>;
  };
  items: { upsert: (doc: unknown, options?: unknown) => Promise<unknown> };
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
  return readDirectivesDocWithEtag(username, fingerprint);
}

/**
 * Internal reader that preserves the Cosmos `_etag`. The public
 * `getDatasetDirectivesDoc` is a thin view over this (its declared return type
 * stays `DatasetDirectivesDoc` — the `_etag` is internal IfMatch plumbing).
 */
async function readDirectivesDocWithEtag(
  username: string,
  fingerprint: string
): Promise<DatasetDirectivesDocWithEtag> {
  const container = await getContainerForOps();
  const id = docIdFor(username, fingerprint);
  const partition = normaliseUsername(username);
  try {
    const { resource } = await container.item(id, partition).read();
    if (!resource) return emptyDoc(username, fingerprint);
    const parsed = datasetDirectivesDocSchema.safeParse(resource);
    if (!parsed.success) {
      logger.warn(
        `⚠️ dataset_directives doc ${id} failed schema parse; returning empty`,
        parsed.error.issues.slice(0, 3)
      );
      return emptyDoc(username, fingerprint);
    }
    // `safeParse` strips `_etag` (strict object) — carry it through for IfMatch.
    return { ...parsed.data, _etag: (resource as { _etag?: string })._etag };
  } catch (err: unknown) {
    // 404 = not yet created; treat as empty. `code` is a numeric Cosmos status
    // here (matching `isPreconditionFailed` above), so narrow rather than using
    // the string-returning getErrorCode helper — preserves the numeric compare.
    const e = err as { code?: number } | null;
    if (e?.code === 404) return emptyDoc(username, fingerprint);
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
    logger.warn("⚠️ hydrateDirectivesForSession failed (returning []):", e);
    return [];
  }
}

/**
 * Internal: upsert the doc with version + updatedAt bumped, under an optimistic-
 * concurrency IfMatch `_etag` precondition (when the doc has been persisted
 * before — a fresh empty doc has none, so its first write is an unconditional
 * create). A concurrent writer on another instance that moved the doc makes
 * Cosmos throw 412; this rejects rather than overwriting. The caller
 * (`mutateDirectivesDoc`) re-reads + re-applies + retries.
 *
 * Returns the next doc carrying the new (unknown-until-server-round-trip)
 * `_etag` as undefined — callers that need the fresh `_etag` re-read.
 */
async function writeDoc(
  doc: DatasetDirectivesDocWithEtag
): Promise<DatasetDirectivesDocWithEtag> {
  const container = await getContainerForOps();
  const { _etag, ...body } = doc;
  const next: DatasetDirectivesDoc = {
    ...body,
    version: body.version + 1,
    updatedAt: Date.now(),
  };
  // Optimistic concurrency: when an `_etag` is present the upsert becomes a
  // conditional replace (IfMatch) — a stale write throws 412 instead of
  // last-writer-wins. Mirrors `updateChatDocument`'s ifMatchEtag path.
  await container.items.upsert(
    next,
    _etag ? { accessCondition: { type: "IfMatch", condition: _etag } } : undefined
  );
  return next;
}

/**
 * Read-modify-write seam for the directives doc, mirroring `mutateChatDocument`
 * (chat.model.ts): read FRESH, run `mutate`, `writeDoc` (IfMatch), and on a 412
 * (a writer on another instance moved the doc) re-read + re-apply + retry,
 * bounded by `MAX_WRITE_RETRIES`. `mutate` returns the next directives array, or
 * `null` to abort the write (nothing changed). Callers already hold the
 * per-(user, fingerprint) write lock, so this serialises in-process writers AND
 * survives cross-instance races.
 */
async function mutateDirectivesDoc<T>(
  username: string,
  fingerprint: string,
  mutate: (doc: DatasetDirectivesDocWithEtag) => { directives: UserDirective[]; result: T } | null
): Promise<{ doc: DatasetDirectivesDocWithEtag; result: T } | null> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
    const doc = await readDirectivesDocWithEtag(username, fingerprint);
    const mutation = mutate(doc);
    if (mutation === null) return null; // mutator aborted — no write
    try {
      const persisted = await writeDoc({ ...doc, directives: mutation.directives });
      return { doc: persisted, result: mutation.result };
    } catch (err) {
      if (isPreconditionFailed(err) && attempt < MAX_WRITE_RETRIES) {
        lastErr = err;
        logger.warn(
          `↻ dataset_directives: 412 on ${docIdFor(username, fingerprint)} ` +
            `(attempt ${attempt}/${MAX_WRITE_RETRIES}); retrying against fresh doc`
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(
        `mutateDirectivesDoc: exhausted retries for ${docIdFor(username, fingerprint)}`
      );
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
    // `generateDirectiveId` embeds a leading timestamp; minting once outside the
    // retry loop keeps the id stable across re-reads (behaviour-preserving) so a
    // 412 retry doesn't shift the directive's id/sort order.
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
    const mutated = await mutateDirectivesDoc(username, fingerprint, (doc) => {
      const updatedDirectives = doc.directives.map((d) =>
        supersedeSet.has(d.id) && d.status === "active"
          ? { ...d, status: "superseded" as const, supersededBy: newDirective.id }
          : d
      );
      updatedDirectives.push(newDirective);
      return { directives: updatedDirectives, result: undefined };
    });
    // Append always writes (never aborts), so `mutated` is non-null here.
    return { doc: mutated!.doc, directive: newDirective };
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
    const mutated = await mutateDirectivesDoc(username, fingerprint, (doc) => {
      let changed = false;
      const updated = doc.directives.map((d) => {
        if (d.id !== directiveId) return d;
        if (d.status === "revoked") return d;
        changed = true;
        return { ...d, status: "revoked" as const };
      });
      if (!changed) return null; // not found / already revoked — abort the write
      return { directives: updated, result: undefined };
    });
    return mutated ? mutated.doc : null;
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
        items: { upsert: (doc: unknown, options?: unknown) => Promise<unknown> };
      }
    | null
): void {
  testContainerOverride = stub;
}
