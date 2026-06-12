/**
 * ============================================================================
 * extractUserDirectivesLlm.ts — AI pass that spots standing user instructions
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A "directive" is a persistent rule the user wants applied across many
 *   future questions, not a one-off filter — e.g. "from now on always exclude
 *   the Central region" or "interpret 'budget' as cost_cap_eur". This file uses
 *   a cheap LLM call to read the user's latest chat message and pull out any
 *   such standing instructions, returning them as structured drafts.
 *
 *   It is the AI companion to a faster regex-based extractor
 *   (./extractUserDirectives.ts). The regex pass catches the obvious "always
 *   exclude X" wording; this LLM pass catches verbose paraphrases the regex
 *   misses ("I'd really prefer we not bring up Hair Oil any more") and judges
 *   trickier cases where a new instruction contradicts ("supersedes") an
 *   existing one in a non-obvious way. Results are cached per message (so the
 *   same message never costs a second call) and every failure quietly returns
 *   an empty list — a model outage must never block the user's chat turn.
 *
 * WHY IT MATTERS
 *   Without it, the tool would forget the user's standing preferences whenever
 *   they were phrased conversationally, and would re-apply rules the user has
 *   since reversed. Together with the regex pass it keeps long-term user
 *   instructions sticky and contradiction-free.
 *
 * KEY PIECES
 *   - extractUserDirectivesLlm(input) — runs the LLM extractor on one message;
 *     returns drafts (possibly empty); cached, never throws.
 *   - mergeDirectiveExtractions(deterministic, llm) — unions the regex and LLM
 *     outputs by structural key; the DETERMINISTIC pass wins on conflict (its
 *     supersede + column projection logic is the source of truth).
 *   - llmDirectiveSchema / LLM_DIRECTIVE_SYSTEM — the strict output shape and
 *     the system prompt instructing the model what counts as "persistent".
 *   - In-process cache (cacheKey/cacheGet/cacheSet) keyed by
 *     (dataset fingerprint, message, active-directive ids), 30-minute TTL.
 *
 * HOW IT CONNECTS
 *   Uses `completeJson` from ./llmJson.js for the MINI-tier LLM call
 *   (LLM_PURPOSE.DIRECTIVE_EXTRACTION). Produces `ExtractedDirective` /
 *   `DirectiveDraft` shapes shared with ./extractUserDirectives.js and
 *   ../../../models/datasetDirectives.model.js. The merged result feeds the
 *   directive-persistence layer that stores per-dataset user rules.
 */
import { createHash } from "crypto";
import { z } from "zod";
import type { DataSummary, UserDirective } from "../../../shared/schema.js";
import type { DirectiveDraft } from "../../../models/datasetDirectives.model.js";
import type { ExtractedDirective } from "./extractUserDirectives.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { logger } from "../../logger.js";

// ──────────────────────────────────────────────────────────────────────────
// Cache (per-process, message-hash keyed)
// ──────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number;
  value: ExtractedDirective[];
}
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — directives are stable
const CACHE_MAX_ENTRIES = 256;
const cache = new Map<string, CacheEntry>();

function cacheKey(
  message: string,
  fingerprint: string,
  existingIds: string[]
): string {
  const idsSorted = existingIds.slice().sort().join("|");
  const seed = `${fingerprint}::${idsSorted}::${message}`;
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}

function cacheGet(key: string): ExtractedDirective[] | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: ExtractedDirective[]): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop oldest insertion. Map preserves insertion order so the first key
    // returned by the iterator is the oldest.
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

/** Test-only — clear the in-process cache between tests. */
export function __clearDirectiveLlmCacheForTesting(): void {
  cache.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// LLM call
// ──────────────────────────────────────────────────────────────────────────

const llmDirectiveSchema = z.object({
  directives: z
    .array(
      z.object({
        kind: z.enum([
          "exclude",
          "include-only",
          "rename",
          "preference",
          "definition",
          "free-text",
        ]),
        text: z.string().min(1),
        column: z.string().min(1).optional(),
        op: z.enum(["in", "not_in", "eq", "neq"]).optional(),
        values: z.array(z.string().min(1)).max(200).optional(),
        supersedeIds: z.array(z.string().min(1)).max(50).optional(),
      })
    )
    .max(20),
});

const LLM_DIRECTIVE_SYSTEM = `You are a precise extractor of PERSISTENT user instructions from a chat message about a tabular dataset.
You are given the user's CURRENT message, the dataset's columns, and a list of CURRENTLY-ACTIVE user directives (with ids).

Your job:
1. Identify zero or more PERSISTENT instructions in the message — rules the user means to apply across many future turns, not one-off filters for this one question.
   - Persistence markers: "always", "from now on", "going forward", "for this dataset", "permanently", "by default", "every time", "in general", "hereafter".
   - NEVER emit a directive for a one-off question that lacks any persistence marker.
2. For each persistent instruction:
   - Set "kind": one of exclude / include-only / rename / preference / definition / free-text.
   - Quote the user's sentence verbatim into "text".
   - When the instruction targets a specific column's values, set "column", "op", and "values" using EXACT column names from the schema.
   - When the new instruction directly contradicts an existing active directive (e.g., the user reverses an earlier "exclude Pure Sense" with "actually include Pure Sense going forward"), put that prior directive's id in "supersedeIds". Only flag a supersede when the contradiction is unambiguous — when in doubt, OMIT supersedeIds and let both co-exist.
3. Output STRICT JSON matching: { "directives": [...] }. Return { "directives": [] } when the message has no persistent instruction.

CRITICAL: Do not hallucinate columns or values — when the user's value isn't in the categorical list provided, omit "column"/"op"/"values" and emit kind:"free-text" instead.`;

interface LlmExtractInput {
  message: string;
  summary: DataSummary;
  existingDirectives: UserDirective[];
  sourceSessionId?: string;
  sourceTurnId?: string;
  /** Per-dataset fingerprint — combined with the message + existing ids to
   *  form the cache key. */
  datasetFingerprint?: string;
}

function summariseSchemaForPrompt(summary: DataSummary): {
  columns: Array<{ name: string; type: string; topValues?: string[] }>;
} {
  const cap = 12;
  return {
    columns: summary.columns.map((c) => ({
      name: c.name,
      type: c.type,
      topValues: c.topValues?.length
        ? c.topValues
            .slice(0, cap)
            .map((t) => String(t.value).trim())
            .filter(Boolean)
        : undefined,
    })),
  };
}

function summariseExistingForPrompt(existing: UserDirective[]): Array<{
  id: string;
  kind: string;
  text: string;
  column?: string;
  op?: string;
  values?: string[];
}> {
  return existing
    .filter((d) => d.status === "active")
    .slice(0, 40)
    .map((d) => ({
      id: d.id,
      kind: d.kind,
      text: d.text.slice(0, 400),
      column: d.structured?.column,
      op: d.structured?.op,
      values: d.structured?.values,
    }));
}

/**
 * Run the LLM directive extractor on a single user message. Returns the
 * extracted drafts (possibly empty). Failures collapse to `[]` and are
 * logged but never thrown. Results are cached per (fingerprint, message,
 * existing-directive-ids) for 30 minutes.
 *
 * Production note: this is a MINI-tier call (~200–600 tokens of input,
 * <300 tokens of output). Cost is bounded by the cache: re-asking the
 * same question doesn't re-pay the LLM.
 */
export async function extractUserDirectivesLlm(
  input: LlmExtractInput
): Promise<ExtractedDirective[]> {
  const message = input.message?.trim() ?? "";
  if (!message) return [];

  const existingActive = input.existingDirectives.filter(
    (d) => d.status === "active"
  );
  const key = cacheKey(
    message,
    input.datasetFingerprint ?? "",
    existingActive.map((d) => d.id)
  );
  const cached = cacheGet(key);
  if (cached) return cached;

  const userJson = JSON.stringify({
    USER_MESSAGE: message,
    SCHEMA: summariseSchemaForPrompt(input.summary),
    EXISTING_DIRECTIVES: summariseExistingForPrompt(existingActive),
  });

  let result;
  try {
    result = await completeJson(LLM_DIRECTIVE_SYSTEM, userJson, llmDirectiveSchema, {
      turnId: "directive_extraction",
      maxTokens: 768,
      temperature: 0.1,
      purpose: LLM_PURPOSE.DIRECTIVE_EXTRACTION,
    });
  } catch (err) {
    logger.warn("⚠️ extractUserDirectivesLlm completeJson threw:", err);
    cacheSet(key, []);
    return [];
  }
  if (!result.ok) {
    logger.warn("⚠️ extractUserDirectivesLlm failed:", result.error);
    cacheSet(key, []);
    return [];
  }

  const existingIds = new Set(existingActive.map((d) => d.id));
  const out: ExtractedDirective[] = [];
  for (const item of result.data.directives) {
    const text = item.text.trim();
    if (!text) continue;
    const structured =
      item.column && item.op
        ? {
            column: item.column,
            op: item.op,
            values: item.values?.length ? item.values : undefined,
          }
        : undefined;
    const supersedeIds = (item.supersedeIds ?? []).filter((id) =>
      existingIds.has(id)
    );
    const draft: DirectiveDraft = {
      scope: "dataset",
      kind: item.kind,
      text,
      structured,
      source: "chat-message",
      sourceSessionId: input.sourceSessionId,
      sourceTurnId: input.sourceTurnId,
      ...(supersedeIds.length > 0 ? { supersedes: supersedeIds } : {}),
    };
    out.push({ draft, triggerSpan: text });
  }

  cacheSet(key, out);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Merge with deterministic pass
// ──────────────────────────────────────────────────────────────────────────

/** Build a stable structural key for deduplication across the two extractors. */
function structuralKey(item: ExtractedDirective): string {
  const s = item.draft.structured;
  const col = s?.column ?? "";
  const op = s?.op ?? "";
  const vals = (s?.values ?? []).slice().sort().join(",");
  return `${item.draft.kind}::${col}::${op}::${vals}::${item.triggerSpan.trim().toLowerCase()}`;
}

/**
 * Merge deterministic + LLM extractor outputs.
 *
 * Policy: when both extractors emit a directive with the same structural
 * key, the **deterministic** one wins. Its supersede list is authoritative
 * (the LLM may hallucinate id matches). LLM-only directives — typically
 * fuzzy paraphrases or `kind: "free-text"` preferences — are appended in
 * the order the LLM returned them.
 */
export function mergeDirectiveExtractions(
  deterministic: ExtractedDirective[],
  llm: ExtractedDirective[]
): ExtractedDirective[] {
  const seen = new Set<string>();
  const out: ExtractedDirective[] = [];
  for (const item of deterministic) {
    const key = structuralKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  for (const item of llm) {
    const key = structuralKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Test-only exports
// ──────────────────────────────────────────────────────────────────────────

export const __cacheKeyForTesting = cacheKey;
export const __structuralKeyForTesting = structuralKey;
