/**
 * Wave W-UD-integration · pure helper that runs the deterministic
 * directive extractor over the current user message and persists any
 * resulting directives through the `dataset_directives` model.
 *
 * Lives in its own file so the chat-stream wiring can be unit-tested
 * without dragging the 4 KLOC `processStreamChat` host into the test
 * harness. The host invokes this once per user turn (after the chat
 * doc is loaded and the user message timestamp is settled) with
 * injectable `appendDirective` + `onAdded` seams so tests can pin
 * the (extract → append → notify) sequence with in-memory stubs.
 *
 * The helper is permissive on failure: a misbehaving extractor or a
 * Cosmos write blip must never block the user's turn or surface a
 * stack trace to the SSE stream. Each per-draft failure is logged
 * but otherwise swallowed so the loop continues for the rest.
 */
import type { DataSummary, UserDirective } from "../../shared/schema.js";
import type { DirectiveDraft } from "../../models/datasetDirectives.model.js";
import {
  extractUserDirectives,
  type ExtractedDirective,
} from "../../lib/agents/runtime/extractUserDirectives.js";
import {
  extractUserDirectivesLlm,
  mergeDirectiveExtractions,
} from "../../lib/agents/runtime/extractUserDirectivesLlm.js";
import { logger } from "../../lib/logger.js";

export interface PersistDirectivesParams {
  /** Owner of the dataset_directives doc. */
  username: string;
  /** Per-dataset key (sha256-16 of sorted lowercase columns+types). */
  fingerprint: string;
  /** Verbatim user message for this turn. */
  message: string;
  /** Dataset summary — needed by the extractor for column-aware inference. */
  summary: DataSummary;
  /** Directives already active for `(username, fingerprint)` at turn start.
   *  Used by the extractor for supersede detection (opposing op + overlap). */
  existingDirectives: UserDirective[];
  /** Originating session for audit trail. */
  sourceSessionId?: string;
  /** Originating user-message timestamp / id for audit trail. */
  sourceTurnId?: string;
  /** Injectable Cosmos writer. Production callers pass the imported
   *  `appendDirective` from `datasetDirectives.model.js`. */
  appendDirective: (
    username: string,
    fingerprint: string,
    draft: DirectiveDraft
  ) => Promise<{ directive: UserDirective }>;
  /** Called once per successfully persisted directive. Production callers
   *  emit a `directive_added` SSE row here so the client renders a chip. */
  onAdded?: (directive: UserDirective, trigger: ExtractedDirective) => void;
  /** Optional override for the deterministic extractor — tests inject a
   *  stub instead of the real `extractUserDirectives`. Production omits. */
  extractor?: typeof extractUserDirectives;
  /** Optional override for the W-UD5 LLM extractor — tests inject a stub
   *  resolving to a fixed `ExtractedDirective[]`. Production omits and
   *  the real LLM extractor is invoked (cached, MINI-tier, non-throwing). */
  llmExtractor?: (input: {
    message: string;
    summary: DataSummary;
    existingDirectives: UserDirective[];
    sourceSessionId?: string;
    sourceTurnId?: string;
    datasetFingerprint?: string;
  }) => Promise<ExtractedDirective[]>;
  /** When `true`, skip the W-UD5 LLM extractor entirely (deterministic-only).
   *  Default is to also invoke the LLM extractor — its results are merged
   *  with the deterministic ones via `mergeDirectiveExtractions`. */
  skipLlmExtractor?: boolean;
  /** Optional non-throwing diagnostic sink for per-draft failures.
   *  Defaults to `console.warn`. */
  onError?: (err: unknown, context: { phase: "extract" | "llm-extract" | "append" }) => void;
}

export interface PersistDirectivesResult {
  /** Drafts the extractor produced (may be empty). */
  extracted: ExtractedDirective[];
  /** Persisted records, in the order `appendDirective` completed.
   *  Length ≤ `extracted.length` — a Cosmos write failure on one draft
   *  does not abort the rest. */
  persisted: UserDirective[];
}

/**
 * Run the deterministic directive extractor over a user message and
 * persist each resulting draft. Returns the extracted + persisted lists.
 *
 * The function never throws — extractor failures collapse to an empty
 * result, and per-draft append failures are reported via `onError` but
 * do not interrupt the rest of the loop.
 */
export async function persistDirectivesFromUserMessage(
  params: PersistDirectivesParams
): Promise<PersistDirectivesResult> {
  const onError =
    params.onError ??
    ((err: unknown, ctx: { phase: "extract" | "llm-extract" | "append" }) => {
      logger.warn(
        `⚠️ persistDirectivesFromUserMessage (${ctx.phase}) failed:`,
        err
      );
    });

  let deterministic: ExtractedDirective[] = [];
  try {
    const fn = params.extractor ?? extractUserDirectives;
    deterministic = fn({
      message: params.message,
      summary: params.summary,
      existingDirectives: params.existingDirectives,
      sourceSessionId: params.sourceSessionId,
      sourceTurnId: params.sourceTurnId,
    });
  } catch (err) {
    onError(err, { phase: "extract" });
    deterministic = [];
  }

  // Wave W-UD5 · run the LLM extractor in parallel-ish (deterministic is
  // synchronous so it's already done; we await the LLM here). The two are
  // merged via `mergeDirectiveExtractions` — deterministic wins on overlap.
  let llmOut: ExtractedDirective[] = [];
  if (!params.skipLlmExtractor) {
    try {
      const fn = params.llmExtractor ?? extractUserDirectivesLlm;
      llmOut = await fn({
        message: params.message,
        summary: params.summary,
        existingDirectives: params.existingDirectives,
        sourceSessionId: params.sourceSessionId,
        sourceTurnId: params.sourceTurnId,
        datasetFingerprint: params.fingerprint,
      });
    } catch (err) {
      onError(err, { phase: "llm-extract" });
      llmOut = [];
    }
  }

  const extracted = mergeDirectiveExtractions(deterministic, llmOut);
  if (extracted.length === 0) return { extracted, persisted: [] };

  const persisted: UserDirective[] = [];
  for (const item of extracted) {
    try {
      const { directive } = await params.appendDirective(
        params.username,
        params.fingerprint,
        item.draft
      );
      persisted.push(directive);
      try {
        params.onAdded?.(directive, item);
      } catch (notifyErr) {
        // A misbehaving SSE emitter must not abort the persistence loop.
        onError(notifyErr, { phase: "append" });
      }
    } catch (err) {
      onError(err, { phase: "append" });
    }
  }

  return { extracted, persisted };
}
