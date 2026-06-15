/**
 * Wave WI2-server · POST /api/insight/regen helpers.
 *
 * Companion server side for WI2-cache (shipped 2026-05-18) — the
 * client-side closure-backed LRU+TTL cache that stores per-tile regen
 * results keyed by `(tileId, filterHash)`. WI2-cache shipped without an
 * endpoint to populate the cache; WI2-server is that endpoint, kept as
 * a single MINI-tier LLM call wrapped in deterministic pre/post
 * helpers so a future WI2-wire hook can call `POST /api/insight/regen`
 * on cache miss and merge the response straight into the cache via
 * `cache.set(buildCacheKey(tileId, hashGlobalFilters(filters)),
 * response)`.
 *
 * Shape: the request carries `{ tileId, spec, filteredData,
 * domainContext?, datasetContextHint? }` and the response is exactly
 * `InsightRegenEntry` from
 * [`insightRegenCache.ts`](../../client/src/pages/Dashboard/lib/insightRegenCache.ts)
 * — `{ text, citations?, regeneratedAt, confidenceTier }`. The
 * client hook calls this on cache miss; the cache stores the result
 * verbatim.
 *
 * The wave is structured as five small pure helpers + one network
 * boundary:
 *
 *   - `regenInsightRequestSchema` / `regenInsightResponseSchema` —
 *     zod request/response contracts.
 *   - `summarizeFilteredData(rows, spec)` — deterministic statistics
 *     extraction over the filtered rows. No I/O.
 *   - `inferConfidenceTier(rowCount)` — tier heuristic (low / medium /
 *     high) on filtered sample size. Mirrors WQ1's tier vocabulary.
 *   - `extractInsightCitations(text)` — pulls `[pack-id]` tokens from
 *     the model's prose using the same regex shape as W22's domain-lens
 *     citation gate (`/\`([a-z][a-z0-9-]{4,})\`/g` + hyphen rule).
 *   - `buildInsightRegenPrompt(args)` — composes `{ system, user }`
 *     byte-stably so identical requests in the same session reuse the
 *     prompt-cache window.
 *   - `regenInsightForFilteredView(args)` — the network boundary. Calls
 *     `callLlm` with the new `LLM_PURPOSE.INSIGHT_REGEN` MINI tier,
 *     post-processes the response.
 *
 * Pure-Node, no Python. The LLM call is the only side effect.
 */

import { z } from "zod";
import { callLlm } from "./agents/runtime/callLlm.js";
import { LLM_PURPOSE } from "./agents/runtime/llmCallPurpose.js";
import { formatCompactNumber } from "./formatCompactNumber.js";

// ─────────────────────────────────────────────────────────────────────
// Shared types + zod contracts
// ─────────────────────────────────────────────────────────────────────

const confidenceTierSchema = z.enum(["low", "medium", "high"]);
export type ConfidenceTier = z.infer<typeof confidenceTierSchema>;

const insightChartSpecLiteSchema = z
  .object({
    type: z.string().min(1).max(40),
    title: z.string().max(240).optional(),
    x: z.string().min(1).max(200),
    y: z.string().min(1).max(200),
    seriesColumn: z.string().min(1).max(200).optional(),
    aggregate: z.string().max(16).optional(),
  })
  .strict();

export const regenInsightRequestSchema = z
  .object({
    /** Tile id — used only for telemetry; the cache key is built client-side. */
    tileId: z.string().min(1).max(120),
    /** Compact chart spec — only the fields the prompt needs (type/title/x/y/seriesColumn/aggregate). */
    spec: insightChartSpecLiteSchema,
    /**
     * Rows after the active global + per-tile filters have been applied.
     * The client sends the post-filter slice the user sees on screen so
     * the prompt can describe THIS view, not the full dataset.
     */
    filteredData: z
      .array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])))
      .max(5000),
    /** Optional domain pack block (already rendered to text). Threaded into the system prompt. */
    domainContext: z.string().max(8_000).optional(),
    /** Optional one-liner about the dataset (e.g. "FMCG haircare; weekly retail audit Apr–Sep 2025"). */
    datasetContextHint: z.string().max(400).optional(),
  })
  .strict();

export type RegenInsightRequest = z.infer<typeof regenInsightRequestSchema>;

export const regenInsightResponseSchema = z
  .object({
    /** Generated insight prose. 1–3 sentences typical; capped at 1200 chars. */
    text: z.string().min(1).max(1200),
    /** Domain pack ids the prose cited (W22 regex shape). */
    citations: z.array(z.string().min(5).max(80)).max(20).optional(),
    /** ISO timestamp when the regen completed (server-set). */
    regeneratedAt: z.string().max(40),
    /** WQ1 tier inferred from filtered sample size. */
    confidenceTier: confidenceTierSchema,
  })
  .strict();

export type RegenInsightResponse = z.infer<typeof regenInsightResponseSchema>;

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

export interface FilteredDataSummary {
  rowCount: number;
  topRow: { x: string; y: number } | null;
  bottomRow: { x: string; y: number } | null;
  mean: number | null;
  /** First 6 distinct x-values in encountered order, for a "covers …" hint. */
  xValuesPreview: string[];
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const cleaned = trimmed.replace(/[%,]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toLabel(v: unknown): string {
  if (v === null || v === undefined) return "(null)";
  return String(v);
}

/**
 * Pure deterministic summary of the filtered slice. The prompt consumes
 * this — having the summary as its own helper means tests can pin the
 * exact statistical anchors the prompt embeds without spinning a real
 * LLM call.
 */
export function summarizeFilteredData(
  rows: Array<Record<string, unknown>>,
  spec: { x: string; y: string },
): FilteredDataSummary {
  const summary: FilteredDataSummary = {
    rowCount: rows.length,
    topRow: null,
    bottomRow: null,
    mean: null,
    xValuesPreview: [],
  };
  if (rows.length === 0) return summary;

  const seenX = new Set<string>();
  let sum = 0;
  let n = 0;
  let topRow: { x: string; y: number } | null = null;
  let bottomRow: { x: string; y: number } | null = null;

  for (const row of rows) {
    const xLabel = toLabel(row[spec.x]);
    if (!seenX.has(xLabel) && summary.xValuesPreview.length < 6) {
      seenX.add(xLabel);
      summary.xValuesPreview.push(xLabel);
    }
    const yNum = toNumberOrNull(row[spec.y]);
    if (yNum === null) continue;
    sum += yNum;
    n += 1;
    if (topRow === null || yNum > topRow.y) topRow = { x: xLabel, y: yNum };
    if (bottomRow === null || yNum < bottomRow.y) {
      bottomRow = { x: xLabel, y: yNum };
    }
  }

  summary.topRow = topRow;
  summary.bottomRow = bottomRow;
  summary.mean = n > 0 ? sum / n : null;
  return summary;
}

/**
 * Mirrors WQ1's tier vocabulary. <10 rows → low (the user is looking
 * at a slice the model shouldn't make strong claims about). 10..99 →
 * medium. ≥100 → high. The 1000-row max in the request schema bounds
 * the upper end naturally.
 */
export function inferConfidenceTier(rowCount: number): ConfidenceTier {
  if (rowCount < 10) return "low";
  if (rowCount < 100) return "medium";
  return "high";
}

/**
 * Mirrors W22's `CITATION_TOKEN_RE` from
 * [`checkEnvelopeCompleteness.ts`](./agents/runtime/checkEnvelopeCompleteness.ts):
 * a token matches when it sits inside backticks, starts with a lowercase
 * letter, and is ≥5 chars total. The hyphen rule (a pack id must
 * contain at least one `-`) filters generic backtick spans like `value`.
 * Dedupes while preserving first-occurrence order.
 */
const INSIGHT_CITATION_RE = /`([a-z][a-z0-9-]{4,})`/g;

export function extractInsightCitations(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  INSIGHT_CITATION_RE.lastIndex = 0;
  while ((m = INSIGHT_CITATION_RE.exec(text)) !== null) {
    const tok = m[1]!;
    if (!tok.includes("-")) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

// Narrative magnitude formatting is owned by the shared authority
// (formatCompactNumber) so every path renders 1.5M / 15.2K identically — this
// module previously rolled its own always-2dp variant ("1.50M"). The only local
// concern kept here is the "n/a" rendering for non-finite values.
function formatNumberCompact(n: number): string {
  return Number.isFinite(n) ? formatCompactNumber(n) : "n/a";
}

export interface InsightRegenPrompt {
  system: string;
  user: string;
}

/**
 * Compose the byte-stable system + user prompt pair. System carries the
 * persona + output contract (1–3 sentences, cite packs in backticks
 * only when supported). User carries the per-request slice summary,
 * spec coordinates, and optional domain / dataset context. Byte
 * stability is critical: prompt-cache hits across tiles in the same
 * session require the system prompt to render identically. The user
 * block is per-request and is NOT byte-stable across tiles by design.
 */
export function buildInsightRegenPrompt(args: {
  spec: RegenInsightRequest["spec"];
  summary: FilteredDataSummary;
  domainContext?: string | null;
  datasetContextHint?: string | null;
}): InsightRegenPrompt {
  const { spec, summary, domainContext, datasetContextHint } = args;

  const system = [
    "You are an analytical insight summariser.",
    "Given a chart spec + a deterministic summary of its post-filter slice,",
    "produce ONE to THREE short sentences in plain prose that name the most",
    "actionable pattern in the slice (top performer, magnitude vs mean,",
    "notable laggard). Use the dimension labels verbatim. When the supplied",
    "DOMAIN CONTEXT block names a pack id you draw from, cite it as a",
    "backticked id like `kpi-and-metric-glossary`. Cite ONLY pack ids that",
    "appear in DOMAIN CONTEXT — never invent identifiers. Output plain",
    "markdown only — no bullet lists, no headings, no preamble like \"This",
    "chart shows…\". Stay under 600 characters total.",
  ].join(" ");

  const lines: string[] = [];
  lines.push(`CHART:`);
  lines.push(`- type: ${spec.type}`);
  if (spec.title) lines.push(`- title: ${spec.title}`);
  lines.push(`- x: ${spec.x}`);
  lines.push(`- y: ${spec.y}`);
  if (spec.seriesColumn) lines.push(`- seriesColumn: ${spec.seriesColumn}`);
  if (spec.aggregate) lines.push(`- aggregate: ${spec.aggregate}`);

  lines.push(``);
  lines.push(`FILTERED SLICE SUMMARY:`);
  lines.push(`- rowCount: ${summary.rowCount}`);
  if (summary.topRow) {
    lines.push(
      `- top: ${spec.x}="${summary.topRow.x}" with ${spec.y}=${formatNumberCompact(summary.topRow.y)}`,
    );
  }
  if (summary.bottomRow) {
    lines.push(
      `- bottom: ${spec.x}="${summary.bottomRow.x}" with ${spec.y}=${formatNumberCompact(summary.bottomRow.y)}`,
    );
  }
  if (summary.mean !== null) {
    lines.push(`- mean(${spec.y}): ${formatNumberCompact(summary.mean)}`);
  }
  if (summary.xValuesPreview.length > 0) {
    lines.push(
      `- ${spec.x} values present: ${summary.xValuesPreview.map((v) => `"${v}"`).join(", ")}${summary.rowCount > summary.xValuesPreview.length ? " …" : ""}`,
    );
  }

  if (datasetContextHint && datasetContextHint.trim().length > 0) {
    lines.push(``);
    lines.push(`DATASET CONTEXT: ${datasetContextHint.trim()}`);
  }
  if (domainContext && domainContext.trim().length > 0) {
    lines.push(``);
    lines.push(`DOMAIN CONTEXT:`);
    lines.push(domainContext.trim());
  }

  lines.push(``);
  lines.push(`Now produce the 1–3 sentence insight for THIS filtered slice.`);

  return { system, user: lines.join("\n") };
}

// ─────────────────────────────────────────────────────────────────────
// Network boundary — single MINI-tier call
// ─────────────────────────────────────────────────────────────────────

const INSIGHT_TEXT_MAX_CHARS = 1200;

/**
 * Trim model output to fit the response schema, collapse repeated
 * whitespace, strip a leading `>` blockquote a chatty model might add.
 */
function normaliseInsightText(raw: string): string {
  let s = (raw ?? "").trim();
  s = s.replace(/^>\s*/gm, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > INSIGHT_TEXT_MAX_CHARS) {
    s = s.slice(0, INSIGHT_TEXT_MAX_CHARS - 1) + "…";
  }
  return s;
}

/**
 * Main entry point — invoked by the route handler. Pure-ish: only side
 * effect is the `callLlm` call. Pre/post processing is deterministic so
 * tests can stub the LLM and pin the rest.
 */
export async function regenInsightForFilteredView(
  request: RegenInsightRequest,
  opts: { turnId?: string; model?: string } = {},
): Promise<RegenInsightResponse> {
  const summary = summarizeFilteredData(request.filteredData, {
    x: request.spec.x,
    y: request.spec.y,
  });
  const { system, user } = buildInsightRegenPrompt({
    spec: request.spec,
    summary,
    domainContext: request.domainContext,
    datasetContextHint: request.datasetContextHint,
  });

  const completion = await callLlm(
    {
      // resolveModelFor picks the model from OPENAI_MODEL_FOR_INSIGHT_REGEN
      // or the MINI fallback chain — the `model` field is just a default for
      // when LLM_PURPOSE is unset, which it never is here.
      model: opts.model ?? "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: 380,
    },
    {
      purpose: LLM_PURPOSE.INSIGHT_REGEN,
      turnId: opts.turnId ?? `insight-regen-${request.tileId}`,
    },
  );

  const raw = completion.choices?.[0]?.message?.content ?? "";
  const text = normaliseInsightText(typeof raw === "string" ? raw : "");
  const citations = extractInsightCitations(text);
  const confidenceTier = inferConfidenceTier(summary.rowCount);
  const regeneratedAt = new Date().toISOString();

  const out: RegenInsightResponse = {
    text: text || "Not enough signal in the current slice to draw a confident insight.",
    regeneratedAt,
    confidenceTier,
  };
  if (citations.length > 0) out.citations = citations;
  return out;
}
