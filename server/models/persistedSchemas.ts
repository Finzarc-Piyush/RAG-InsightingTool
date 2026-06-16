/**
 * Lenient read-schemas for persisted Cosmos documents.
 *
 * VALIDATE-AND-WARN, never reject. These schemas exist purely as an
 * observability tripwire: when a document read back from Cosmos no longer
 * matches the shape we expect (a partial write, a migration we missed, plain
 * corruption), we want a structured `logger.warn` — NOT a thrown error and NOT
 * a dropped document. Valid documents must continue to behave EXACTLY as they
 * did before this file existed.
 *
 * Why lenient (`.deepPartial().passthrough()`):
 *   - Cosmos documents accrete additive fields over many waves; pre-migration
 *     rows legitimately lack newer fields. A strict schema would false-positive
 *     constantly. So every field is made optional (`deepPartial`) and unknown
 *     keys pass through untouched (`passthrough`).
 *   - What this STILL catches is "gross corruption": a field that is present
 *     but the wrong primitive type (e.g. `createdAt: "oops"` where a number is
 *     expected, or `messages: 5` where an array is expected). That is the
 *     class of failure worth a warn.
 *
 * Mirrors the read-tolerant pattern already used by
 * `pastAnalysis.model.ts` (safeParse, tolerate failure).
 */
import { z } from "zod";
import {
  dashboardSchema,
  sharedAnalysisInviteSchema,
  sharedDashboardInviteSchema,
} from "../shared/schema.js";
import { logger } from "../lib/logger.js";

/**
 * Build a lenient read-schema from a strict write-schema: every field becomes
 * optional (recursively) and unknown keys pass through. The result rejects
 * only when a PRESENT field has the wrong primitive shape.
 */
const lenient = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema.deepPartial().passthrough();

/** Lenient read-shape of a `SharedAnalysisInvite` Cosmos document. */
export const sharedAnalysisInviteReadSchema = lenient(sharedAnalysisInviteSchema);

/** Lenient read-shape of a `SharedDashboardInvite` Cosmos document. */
export const sharedDashboardInviteReadSchema = lenient(sharedDashboardInviteSchema);

/** Lenient read-shape of a `Dashboard` Cosmos document. */
export const dashboardReadSchema = lenient(dashboardSchema);

/**
 * Lenient read-shape of a `ChatDocument` Cosmos document.
 *
 * `ChatDocument` is a hand-written TypeScript interface (no source-of-truth
 * zod schema), and it carries dozens of additive, optional fields that accrete
 * across waves. We deliberately validate ONLY the small structural spine — the
 * fields whose wrong-type-ness would signal gross corruption (an id that isn't
 * a string, a `messages`/`charts` that isn't an array). Everything else passes
 * through untouched via `.passthrough()`. This is a tripwire, not a mirror.
 */
export const chatDocumentReadSchema = z
  .object({
    id: z.string().optional(),
    sessionId: z.string().optional(),
    username: z.string().optional(),
    createdAt: z.number().optional(),
    lastUpdatedAt: z.number().optional(),
    messages: z.array(z.unknown()).optional(),
    charts: z.array(z.unknown()).optional(),
    insights: z.array(z.unknown()).optional(),
    collaborators: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * safeParse a Cosmos resource against a lenient read-schema. On SUCCESS return
 * the parsed value; on FAILURE `logger.warn` (doc id + flattened error) and
 * fall back to the RAW resource. Never throws, never drops the document.
 *
 * The fallback returns the original `resource` (typed as `Expected`) so callers
 * keep the exact same runtime value and downstream behaviour they had before —
 * this is observability layered on top of the existing read path, not a gate.
 */
export function safeParseRead<Expected>(
  label: string,
  schema: z.ZodTypeAny,
  resource: unknown,
): Expected {
  // Mirror `pastAnalysis.model.ts`: nothing to validate for nullish reads.
  if (resource === null || resource === undefined) {
    return resource as Expected;
  }
  const parsed = schema.safeParse(resource);
  if (parsed.success) {
    // Re-cast to the caller's expected runtime type. The lenient schema can
    // widen optionality, so we deliberately do NOT narrow callers to the
    // parsed type — behaviour must be identical to the pre-validation cast.
    return resource as Expected;
  }
  const id =
    (resource as { id?: unknown } | null)?.id != null
      ? String((resource as { id?: unknown }).id)
      : "<unknown id>";
  logger.warn(
    `⚠️ ${label}: persisted document failed read-shape validation (id=${id}); using raw doc`,
    parsed.error.flatten(),
  );
  return resource as Expected;
}
