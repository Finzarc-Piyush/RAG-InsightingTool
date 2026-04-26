/**
 * W5.2 · Exact-match lookup against the `past-analyses` AI Search index.
 *
 * Runs ahead of the agent loop inside chatStream. On a hit, the caller replays
 * the cached answer over SSE and skips the agent turn entirely — the whole
 * point of this wave.
 *
 * Safety filters on every query:
 *   - sessionId: scoped to the same session (same data, same permissions)
 *   - dataVersion: bumps invalidate naturally when the dataset changes
 *   - outcome = "ok": never serve a failed turn from cache
 *   - feedback != "down": thumbs-down removes a row from eligibility
 *   - createdAt > cutoff: TTL safeguard, default 7 days
 *
 * Gated by `QUESTION_CACHE_EXACT_ENABLED=true` (default off). `PAST_ANALYSES_INDEX_ENABLED`
 * also controls whether the AI Search index receives writes; both must be on
 * for the cache to return hits against real data.
 */

import type { PastAnalysisDoc } from "../../shared/schema.js";
import {
  findExactPastAnalysisMatch,
  findSimilarPastAnalyses,
  type PastAnalysisSearchDoc,
} from "../rag/pastAnalysesStore.js";
import { normalizeQuestionForCache } from "./normalizeQuestion.js";

/** Default TTL — a week. Config via `QUESTION_CACHE_TTL_DAYS`. */
const DEFAULT_TTL_DAYS = 7;

export interface CacheHit {
  /** The source AI Search document, which projects PastAnalysisDoc fields + the vector. */
  doc: PastAnalysisSearchDoc;
  /** Lookup mode for telemetry. */
  source: "exact" | "semantic";
  /** ms since the cached answer was produced. */
  ageMs: number;
  /** Similarity score for semantic hits (0–1, cosine). Undefined for exact. */
  score?: number;
}

export interface CacheLookupInput {
  sessionId: string;
  dataVersion: number;
  question: string;
}

function exactFeatureEnabled(): boolean {
  return process.env.QUESTION_CACHE_EXACT_ENABLED === "true";
}

function semanticFeatureEnabled(): boolean {
  return process.env.QUESTION_CACHE_SEMANTIC_ENABLED === "true";
}

/**
 * Similarity threshold for semantic hits (cosine, 0–1). Defaults to 0.92 —
 * conservative enough to reject distinct questions with overlapping vocab.
 * Lower bound guards against a misconfigured env like `=0` effectively turning
 * the cache into "serve anything remotely related". Upper is just sanity.
 */
function semanticThreshold(): number {
  const raw = process.env.QUESTION_CACHE_SIM_THRESHOLD;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 0.92;
  return Math.min(1, Math.max(0.7, n));
}

function ttlCutoffMs(): number {
  const raw = process.env.QUESTION_CACHE_TTL_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

/**
 * Try the exact-match cache. Returns null on any of:
 *   - feature flag off
 *   - empty normalized question
 *   - AI Search call failed (swallowed — cache miss is never worse than no cache)
 *   - no row met the filters
 */
export async function tryExactQuestionCacheHit(
  input: CacheLookupInput
): Promise<CacheHit | null> {
  if (!exactFeatureEnabled()) return null;
  const nq = normalizeQuestionForCache(input.question);
  if (!nq) return null;

  try {
    const hit = await findExactPastAnalysisMatch({
      sessionId: input.sessionId,
      dataVersion: input.dataVersion,
      normalizedQuestion: nq,
      createdAfterEpochMs: ttlCutoffMs(),
    });
    if (!hit) return null;
    return {
      doc: hit,
      source: "exact",
      ageMs: Math.max(0, Date.now() - hit.createdAt),
    };
  } catch (err) {
    // Never let a cache-lookup failure block the turn. Just log + miss.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ exact question cache lookup failed (miss-on-error): ${msg}`);
    return null;
  }
}

/**
 * W5.3 · Semantic-similarity cache lookup. Runs ONLY after exact-match has
 * missed. Embeds the normalized question, asks AI Search for the top-K
 * nearest neighbours scoped to the session + dataVersion + outcome=ok +
 * feedback != down + TTL window, then returns the top result if its cosine
 * score clears `semanticThreshold()`.
 *
 * Conservative by design: default threshold 0.92, scoped filters, and the
 * same caller path that serves exact hits means false positives are caught
 * by the same thumbs-down -> exclusion loop (W5.5).
 */
export async function trySemanticQuestionCacheHit(
  input: CacheLookupInput
): Promise<CacheHit | null> {
  if (!semanticFeatureEnabled()) return null;
  const nq = normalizeQuestionForCache(input.question);
  if (!nq) return null;

  try {
    // Lazy-import so unit tests that don't configure Azure OpenAI aren't
    // blown up by the openai.ts module-load IIFE.
    const { embedQuery } = await import("../rag/embeddings.js");
    const vector = await embedQuery(nq);
    const candidates = await findSimilarPastAnalyses({
      sessionId: input.sessionId,
      dataVersion: input.dataVersion,
      queryVector: vector,
      topK: 5,
      createdAfterEpochMs: ttlCutoffMs(),
    });
    if (candidates.length === 0) return null;
    const top = candidates[0];
    const threshold = semanticThreshold();
    if (top.score < threshold) return null;
    return {
      doc: top.doc,
      source: "semantic",
      ageMs: Math.max(0, Date.now() - top.doc.createdAt),
      score: top.score,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ semantic question cache lookup failed (miss-on-error): ${msg}`);
    return null;
  }
}

/**
 * Reconstruct the bare minimum of a past-analysis record needed to satisfy the
 * downstream chat-history persistence path. We don't hit Cosmos on the hot
 * cache path — the AI Search doc already has the projected fields.
 */
export function projectHitToPastAnalysis(
  hit: CacheHit,
  currentTurnId: string
): Pick<
  PastAnalysisDoc,
  "answer" | "sessionId" | "dataVersion" | "outcome"
> & { sourceTurnId: string; currentTurnId: string } {
  return {
    answer: hit.doc.answer,
    sessionId: hit.doc.sessionId,
    dataVersion: hit.doc.dataVersion,
    outcome: "ok",
    sourceTurnId: hit.doc.turnId,
    currentTurnId,
  };
}
