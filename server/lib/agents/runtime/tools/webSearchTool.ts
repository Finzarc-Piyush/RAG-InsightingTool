/**
 * ============================================================================
 * webSearchTool.ts — let the agent search the open web (the `web_search` tool)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `web_search` tool so the AI planner can pull in outside-world
 *   context the user's own uploaded data can't provide — industry benchmarks,
 *   competitor moves, market news (e.g. "vs industry Q3 growth", "competitor
 *   pack-size moves"). It sends the query to a search provider (Tavily by
 *   default), trims the results to a few short snippets, and returns them
 *   formatted exactly like the app's internal document-search ("RAG") hits so
 *   the answer-writing step treats web text and uploaded-document text the same
 *   way. ("RAG" = retrieval-augmented generation: feeding relevant text into the
 *   model as grounding context.)
 *
 * WHY IT MATTERS
 *   Some questions genuinely need external figures, but the web is noisy and
 *   not authoritative for the user's own numbers — so this tool is deliberately
 *   limited and gated. Results are background context only, never treated as
 *   numeric evidence about the user's dataset. It also de-duplicates URLs
 *   already pulled earlier in the same turn so the same hit isn't fed to the
 *   writer twice.
 *
 * KEY PIECES
 *   - webSearchArgsSchema — validates the query and optional max_results (≤5).
 *   - isWebSearchEnabled — reads the WEB_SEARCH_ENABLED flag.
 *   - tavilySearch — calls the Tavily HTTP API and normalises hits.
 *   - extractUrlsFromFormattedHits / formatHitsForPrompt — parse URLs back out
 *     of, and render hits into, the RAG-style block.
 *   - registerWebSearchTool — registers the tool and ties it all together.
 *
 * HOW IT CONNECTS
 *   Called by the agent act loop via the tool registry (toolRegistry.ts). On
 *   success it also stashes the formatted block on the analytical blackboard
 *   via addDomainContext (../analyticalBlackboard.js) so the synthesis context
 *   bundle picks it up as grounding. Strictly gated: requires both
 *   `WEB_SEARCH_ENABLED=true` AND a provider key (`TAVILY_API_KEY`); without
 *   them the tool registers but returns a clear no-op message so the planner
 *   learns to stop calling it. Failures are non-fatal (return ok:false).
 *
 *   Sized to 5 snippets max, ~1.5k chars per snippet — large enough for a
 *   benchmark figure, small enough not to swamp the synthesis token budget.
 */
import { z } from "zod";
import type { ToolRegistry } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";
import { wrapUntrusted } from "../untrustedContent.js";
import { addDomainContext } from "../analyticalBlackboard.js";

export const webSearchArgsSchema = z
  .object({
    query: z.string().min(1).max(500),
    /** Optional override; capped server-side to 5. */
    max_results: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;

const SNIPPET_MAX_CHARS = 1_500;
const SUMMARY_MAX_CHARS = 6_000;

/**
 * Wave R3 · knowledge-floor guidance appended whenever live retrieval is
 * unavailable (disabled, no provider key, no hits, or a provider error). It
 * turns a dead no-op into a useful instruction so the synthesizer still answers
 * external/world-knowledge questions — from the model's own training knowledge,
 * with an honest caveat and NO fabricated citations. This is how the product
 * "answers anything and never breaks" for research questions even with web
 * search off.
 */
const KNOWLEDGE_FLOOR_GUIDANCE =
  " Answer the external/world-knowledge part of the question from your own background knowledge up to your training cutoff, and clearly caveat that this is general knowledge, not live retrieval. Do NOT invent specific citations, figures, or URLs.";

export function isWebSearchEnabled(): boolean {
  return process.env.WEB_SEARCH_ENABLED === "true";
}

/**
 * Parse a deterministic markdown bibliography out of the formatted web-hit
 * blocks collected on the blackboard this turn (entries with `source: "web"`).
 * The block format is stable — `[web:<provider>:N] Title` then a `— <url>`
 * line — so we can recover (title, url) pairs reliably. Built mechanically
 * (never LLM-authored) so an external-research answer's bibliography can never
 * be hallucinated or silently dropped. Returns "" when no web sources exist.
 */
export function buildBibliographyBlock(webContents: string[]): string {
  if (!webContents || webContents.length === 0) return "";
  const TAG_RE = /^\[web:[^\]]+\]\s*(.*)$/;
  const URL_RE = /^—\s+(https?:\/\/\S+)\s*$/;
  const entries: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const content of webContents) {
    if (!content) continue;
    let pendingTitle: string | null = null;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      const tag = TAG_RE.exec(line);
      if (tag) {
        pendingTitle = (tag[1] || "Untitled").trim() || "Untitled";
        continue;
      }
      const u = URL_RE.exec(line);
      if (u) {
        const url = u[1].trim();
        if (!seen.has(url)) {
          seen.add(url);
          entries.push({ title: pendingTitle || "Source", url });
        }
        pendingTitle = null;
      }
    }
  }
  if (entries.length === 0) return "";
  const lines = entries.map((e, i) => `${i + 1}. [${e.title}](${e.url})`);
  return `## Sources\n${lines.join("\n")}`;
}

interface SearchHit {
  title: string;
  url: string;
  content: string;
}

interface SearchProviderResult {
  hits: SearchHit[];
  providerLabel: string;
}

async function tavilySearch(
  apiKey: string,
  query: string,
  maxResults: number
): Promise<SearchProviderResult> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
      search_depth: "basic",
    }),
  });
  if (!res.ok) {
    throw new Error(`tavily HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const hits: SearchHit[] = (json.results ?? [])
    .filter((r) => r && (r.url || r.title))
    .slice(0, maxResults)
    .map((r) => ({
      title: (r.title ?? "Untitled").slice(0, 200),
      url: (r.url ?? "").slice(0, 400),
      content: (r.content ?? "").slice(0, SNIPPET_MAX_CHARS),
    }));
  return { hits, providerLabel: "tavily" };
}

// ── Wave R4 · free, key-less providers ──────────────────────────────────────
// The default provider is `auto` (Wikipedia + GDELT), neither of which needs an
// API key — so external research works for free out of the box. Tavily (and any
// future paid provider) stays swappable via WEB_SEARCH_PROVIDER and is the only
// provider that requires a key.

const PROVIDER_TIMEOUT_MS = 6_000;

/** Which providers require an API key. Only key-bearing ones gate on a key. */
export function providerNeedsKey(provider: string): boolean {
  return provider === "tavily" || provider === "brave";
}

/** fetch with an AbortController timeout so a hung provider can't stall the turn. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = PROVIDER_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Strip HTML tags + collapse whitespace (Wikipedia snippets are HTML). */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure parser for the Wikipedia `list=search` response shape. */
export function parseWikipediaResults(
  json: unknown,
  maxResults: number
): SearchHit[] {
  const search = (json as { query?: { search?: Array<{ title?: string; snippet?: string }> } })
    ?.query?.search;
  if (!Array.isArray(search)) return [];
  return search
    .filter((r) => r && r.title)
    .slice(0, maxResults)
    .map((r) => ({
      title: (r.title ?? "Untitled").slice(0, 200),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        (r.title ?? "").replace(/ /g, "_")
      )}`,
      content: stripHtml(r.snippet ?? "").slice(0, SNIPPET_MAX_CHARS),
    }));
}

async function wikipediaSearch(
  query: string,
  maxResults: number
): Promise<SearchProviderResult> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*" +
    `&srlimit=${maxResults}&srsearch=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`wikipedia HTTP ${res.status}`);
  return { hits: parseWikipediaResults(await res.json(), maxResults), providerLabel: "wikipedia" };
}

/** Pure parser for the GDELT DOC 2.0 `ArtList` response shape. */
export function parseGdeltResults(json: unknown, maxResults: number): SearchHit[] {
  const articles = (json as {
    articles?: Array<{ title?: string; url?: string; domain?: string; seendate?: string }>;
  })?.articles;
  if (!Array.isArray(articles)) return [];
  return articles
    .filter((a) => a && a.url && a.title)
    .slice(0, maxResults)
    .map((a) => ({
      title: (a.title ?? "Untitled").slice(0, 200),
      url: (a.url ?? "").slice(0, 400),
      content: [a.domain, a.seendate ? `seen ${a.seendate}` : ""]
        .filter(Boolean)
        .join(" · ")
        .slice(0, SNIPPET_MAX_CHARS),
    }));
}

async function gdeltSearch(
  query: string,
  maxResults: number
): Promise<SearchProviderResult> {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?mode=ArtList&format=json&sort=DateDesc" +
    `&maxrecords=${maxResults}&query=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`gdelt HTTP ${res.status}`);
  // GDELT sometimes returns text/plain on empty/odd queries — parse defensively.
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { hits: parseGdeltResults(json, maxResults), providerLabel: "gdelt" };
}

/**
 * Dispatch to the selected provider. `auto` (default) runs the free, key-less
 * providers concurrently and merges their hits, so encyclopedic/competitor
 * questions (Wikipedia) and recent-news questions (GDELT) are both covered. A
 * single provider failing in `auto` is tolerated; if all fail it returns no
 * hits (→ knowledge-floor guidance upstream).
 */
async function runSearchProvider(
  provider: string,
  apiKey: string | undefined,
  query: string,
  maxResults: number
): Promise<SearchProviderResult> {
  switch (provider) {
    case "tavily":
      return tavilySearch(apiKey as string, query, maxResults);
    case "wikipedia":
      return wikipediaSearch(query, maxResults);
    case "gdelt":
      return gdeltSearch(query, maxResults);
    case "auto":
    default: {
      const settled = await Promise.allSettled([
        wikipediaSearch(query, maxResults),
        gdeltSearch(query, maxResults),
      ]);
      const hits: SearchHit[] = [];
      for (const r of settled) {
        if (r.status === "fulfilled") hits.push(...r.value.hits);
        else agentLog("web_search.auto_provider_failed", { error: String(r.reason).slice(0, 200) });
      }
      return { hits: hits.slice(0, maxResults), providerLabel: "web" };
    }
  }
}

/**
 * Pull URLs out of an already-formatted hit block. The format
 * `[web:tavily:N] Title\nContent\n— url` is stable, so a single regex
 * matching the `— ` line is enough. Used to dedup against URLs the
 * planner has already pulled from earlier `web_search` calls in this
 * turn so the synthesis ragBlock doesn't carry the same hit twice.
 */
const URL_LINE_RE = /^—\s+(https?:\/\/\S+)\s*$/gm;
export function extractUrlsFromFormattedHits(formatted: string): string[] {
  if (!formatted) return [];
  const out: string[] = [];
  for (const match of formatted.matchAll(URL_LINE_RE)) {
    out.push(match[1].trim());
  }
  return out;
}

/** Format hits identically to RAG hits so the synthesizer treats them uniformly. */
function formatHitsForPrompt(hits: SearchHit[], providerLabel: string): string {
  if (hits.length === 0) return "";
  const blocks = hits.map((h, i) => {
    const tag = `[web:${providerLabel}:${i + 1}]`;
    const cite = h.url ? `\n— ${h.url}` : "";
    // Wave R18 · fence the untrusted external title+content (the URL/tag stay
    // outside for citation). Prompt-injection in a web result can't pose as an
    // instruction; the synthesizer's UNTRUSTED rule says fenced text is data.
    const body = wrapUntrusted(`WEB_${i + 1}`, `${h.title}\n${h.content.trim()}`);
    return `${tag}\n${body}${cite}`;
  });
  return blocks.join("\n---\n").slice(0, SUMMARY_MAX_CHARS);
}

export function registerWebSearchTool(registry: ToolRegistry): void {
  registry.register(
    "web_search",
    webSearchArgsSchema,
    async (ctx, args) => {
      if (!isWebSearchEnabled()) {
        return {
          ok: false,
          summary:
            "Web search is disabled. Set WEB_SEARCH_ENABLED=true and a provider key (TAVILY_API_KEY) to enable." +
            KNOWLEDGE_FLOOR_GUIDANCE,
        };
      }
      const provider = (process.env.WEB_SEARCH_PROVIDER ?? "auto").trim().toLowerCase();
      const apiKey = process.env.TAVILY_API_KEY?.trim();
      // Only key-bearing providers (tavily/brave) gate on a key. The default
      // `auto` (Wikipedia + GDELT) and the other free providers need none.
      if (providerNeedsKey(provider) && !apiKey) {
        return {
          ok: false,
          summary:
            "Web search is enabled but no provider key found. Set TAVILY_API_KEY (or implement another provider)." +
            KNOWLEDGE_FLOOR_GUIDANCE,
        };
      }
      const query = (args.query as string).trim();
      const maxResults = Math.min((args.max_results as number | undefined) ?? 5, 5);
      try {
        const { hits, providerLabel } = await runSearchProvider(
          provider,
          apiKey,
          query,
          maxResults
        );
        if (hits.length === 0) {
          agentLog("web_search.no_hits", { query: query.slice(0, 200) });
          return {
            ok: true,
            summary:
              "Web search returned no results for this query." +
              KNOWLEDGE_FLOOR_GUIDANCE,
          };
        }
        // Dedup against URLs already in the blackboard from earlier
        // `web_search` calls in this turn. The planner can fire multiple
        // queries (e.g. "Saffola Q3 share" + "Saffola Q3 volume") that
        // return overlapping hits — without dedup the ragBlock carries
        // the same `— url` block twice and confuses the synthesizer.
        const existingUrls = new Set(
          (ctx.exec.blackboard?.domainContext ?? [])
            .filter((e) => e.source === "web")
            .flatMap((e) => extractUrlsFromFormattedHits(e.content))
        );
        const dedupedHits = hits.filter(
          (h) => !h.url || !existingUrls.has(h.url)
        );
        const dropped = hits.length - dedupedHits.length;
        if (dedupedHits.length === 0) {
          agentLog("web_search.all_dup", {
            query: query.slice(0, 200),
            droppedCount: dropped,
          });
          return {
            ok: true,
            summary: `Web search returned ${hits.length} hits but all overlap URLs already in the blackboard from earlier calls in this turn.`,
          };
        }
        const formatted = formatHitsForPrompt(dedupedHits, providerLabel);
        // Also stash the formatted block on the analytical blackboard so the
        // synthesis context bundle picks it up as background grounding in the
        // "Web search context" sub-section. The tool's observation return
        // (below) is unchanged so the planner / working memory still see the
        // hits in their existing slot.
        if (ctx.exec.blackboard) {
          addDomainContext(ctx.exec.blackboard, formatted, "web");
        }
        agentLog("web_search.ok", {
          query: query.slice(0, 200),
          provider: providerLabel,
          hitCount: dedupedHits.length,
          dropped,
          totalLen: formatted.length,
        });
        return {
          ok: true,
          // Web hits are background context — never numeric evidence on their
          // own. The synthesizer/narrator system prompts already enforce
          // "figures only from observations". We surface hits in the same
          // structured shape RAG uses so the writers can cite them similarly.
          summary: formatted,
          numericPayload: formatted,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        agentLog("web_search.failed", { query: query.slice(0, 200), error: msg.slice(0, 300) });
        return {
          ok: false,
          summary: `Web search failed: ${msg.slice(0, 200)}` + KNOWLEDGE_FLOOR_GUIDANCE,
        };
      }
    },
    {
      description:
        "Open-web search / external research for ANY question the uploaded data can't answer alone — benchmarks, peer/competitor context (incl. historical, e.g. 'how did competitor X grow 10 years ago'), category/market facts, news, or external events. For a research question, issue 2–4 targeted queries (entity, metric, time window, market context) then synthesise. Cite hits inline as [web:<provider>:N]; a deterministic Sources bibliography is appended automatically. Never use for figures the dataset itself can answer; tool output / RAG stay authoritative for the user's own numbers. When unavailable it returns guidance to answer from background knowledge with a caveat rather than failing.",
      argsHelp:
        '{"query": string} required, ≤500 chars. {"max_results"?: number} optional, 1–5 (default 5). Use specific phrasing ("Indian FMCG hair-oil category Q3 2024 growth") rather than vague terms.',
    }
  );
}
