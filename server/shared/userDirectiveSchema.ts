import { z } from "zod";

// ============================================================================
// Wave W-UD1 · User directives — per-dataset persistent rules
// ============================================================================
//
// A `UserDirective` captures a user-provided rule that should persist beyond
// the current chat turn — typically:
//   - upload-time domain context ("this dataset is for haircare; treat brand
//     X as a competitor")
//   - mid-conversation instructions ("from now on omit Hair Oil from any
//     category breakdown")
//
// Authoritative storage: the `dataset_directives` Cosmos container, keyed by
// `(username, datasetFingerprint)`. A snapshot is mirrored onto every chat
// session's `ChatDocument.userDirectives` for read-side audit visibility.
//
// Lifecycle: append-only. `status` transitions `active` → `superseded` (newer
// directive overrides it) or `active` → `revoked` (user clicked revoke).
// Nothing is ever deleted; the audit trail is preserved via
// `supersedes` / `supersededBy`.
//
// Extracted from `shared/schema.ts` as a self-contained leaf cluster — these
// schemas reference only each other and `zod`, never the rest of the god-file.
// `shared/schema.ts` re-exports every symbol below so existing
// `from ".../shared/schema.js"` imports keep resolving unchanged.

export const userDirectiveScopeSchema = z.enum([
  "session",
  "dataset",
  // Reserved for Phase B (deferred); the schema accepts them so a future
  // wave can add writer paths without a migration.
  "user",
  "tenant",
]);
export type UserDirectiveScope = z.infer<typeof userDirectiveScopeSchema>;

export const userDirectiveKindSchema = z.enum([
  "exclude",
  "include-only",
  "rename",
  "preference",
  "definition",
  "free-text",
]);
export type UserDirectiveKind = z.infer<typeof userDirectiveKindSchema>;

export const userDirectiveSourceSchema = z.enum([
  "upload-context",
  "chat-message",
  "automation-seed",
  "admin-edit",
]);
export type UserDirectiveSource = z.infer<typeof userDirectiveSourceSchema>;

export const userDirectiveStatusSchema = z.enum([
  "active",
  "superseded",
  "revoked",
]);
export type UserDirectiveStatus = z.infer<typeof userDirectiveStatusSchema>;

/** Structural projection of the directive — when present, the planner /
 *  chart-intent-guard can apply it as a filter without re-parsing the prose. */
export const userDirectiveStructuredSchema = z.object({
  column: z.string().min(1).max(200).optional(),
  op: z.enum(["in", "not_in", "eq", "neq"]).optional(),
  values: z.array(z.string().min(1).max(400)).max(200).optional(),
});
export type UserDirectiveStructured = z.infer<
  typeof userDirectiveStructuredSchema
>;

export const userDirectiveSchema = z.object({
  id: z.string().min(1).max(80),
  scope: userDirectiveScopeSchema,
  kind: userDirectiveKindSchema,
  /** Verbatim text — NO length cap by design. The 2 MB Cosmos doc soft limit
   *  is the only ceiling. */
  text: z.string().min(1),
  structured: userDirectiveStructuredSchema.optional(),
  source: userDirectiveSourceSchema,
  sourceSessionId: z.string().min(1).max(200).optional(),
  sourceTurnId: z.string().min(1).max(200).optional(),
  addedAt: z.number().int().nonnegative(),
  status: userDirectiveStatusSchema,
  /** IDs of prior directives this one replaces. */
  supersedes: z.array(z.string().min(1).max(80)).max(50).optional(),
  /** Set when this directive itself is superseded by a newer one. */
  supersededBy: z.string().min(1).max(80).optional(),
});
export type UserDirective = z.infer<typeof userDirectiveSchema>;

/** Cosmos document body for the `dataset_directives` container.
 *  id = `${username}__${datasetFingerprint}`, partitionKey = username. */
export const datasetDirectivesDocSchema = z.object({
  id: z.string().min(1).max(400),
  username: z.string().min(1).max(200),
  datasetFingerprint: z.string().min(1).max(64),
  directives: z.array(userDirectiveSchema),
  /** Monotonic — bumped on every successful write. Future ETag bridge. */
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type DatasetDirectivesDoc = z.infer<typeof datasetDirectivesDocSchema>;
