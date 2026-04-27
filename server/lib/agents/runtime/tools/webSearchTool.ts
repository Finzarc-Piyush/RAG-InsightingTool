/**
 * Wave W14 · web_search tool (env-gated)
 *
 * Lets the planner consult the open web for benchmark, market, or comparable-
 * peer context the user's uploaded data alone can't answer (e.g. "vs industry
 * Q3 growth", "competitor pack-size moves"). Strictly gated:
 *   - `WEB_SEARCH_ENABLED=true` must be set, AND
 *   - A provider must be configured (default Tavily; key in `TAVILY_API_KEY`).
 * Without both the tool registers but the planner sees a clear no-op message
 * when called, so it learns to stop calling it. Tool failures are non-fatal
 * (return `ok: false` with a reason). Results are returned as a clean prose
 * block formatted exactly like RAG hits, so the synthesis path treats them
 * uniformly with the W7 RAG bundle.
 *
 * Sized to 5 snippets max, ~1.5k chars per snippet — large enough for a
 * benchmark figure, small enough not to swamp synthesis tokens.
 */
import { z } from "zod";
import type { ToolRegistry } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";

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

export function isWebSearchEnabled(): boolean {
  return process.env.WEB_SEARCH_ENABLED === "true";
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

/** Format hits identically to RAG hits so the synthesizer treats them uniformly. */
function formatHitsForPrompt(hits: SearchHit[], providerLabel: string): string {
  if (hits.length === 0) return "";
  const blocks = hits.map((h, i) => {
    const tag = `[web:${providerLabel}:${i + 1}]`;
    const cite = h.url ? `\n— ${h.url}` : "";
    return `${tag} ${h.title}\n${h.content.trim()}${cite}`;
  });
  return blocks.join("\n---\n").slice(0, SUMMARY_MAX_CHARS);
}

export function registerWebSearchTool(registry: ToolRegistry): void {
  registry.register(
    "web_search",
    webSearchArgsSchema,
    async (_ctx, args) => {
      if (!isWebSearchEnabled()) {
        return {
          ok: false,
          summary:
            "Web search is disabled. Set WEB_SEARCH_ENABLED=true and a provider key (TAVILY_API_KEY) to enable.",
        };
      }
      const apiKey = process.env.TAVILY_API_KEY?.trim();
      if (!apiKey) {
        return {
          ok: false,
          summary:
            "Web search is enabled but no provider key found. Set TAVILY_API_KEY (or implement another provider).",
        };
      }
      const query = (args.query as string).trim();
      const maxResults = Math.min((args.max_results as number | undefined) ?? 5, 5);
      try {
        const { hits, providerLabel } = await tavilySearch(apiKey, query, maxResults);
        if (hits.length === 0) {
          agentLog("web_search.no_hits", { query: query.slice(0, 200) });
          return {
            ok: true,
            summary: "Web search returned no results for this query.",
          };
        }
        const formatted = formatHitsForPrompt(hits, providerLabel);
        agentLog("web_search.ok", {
          query: query.slice(0, 200),
          provider: providerLabel,
          hitCount: hits.length,
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
          summary: `Web search failed: ${msg.slice(0, 200)}`,
        };
      }
    },
    {
      description:
        "Open-web search for benchmarks, peer/competitor context, or external figures the user's data can't answer alone. Use sparingly — only when the question explicitly invokes industry comparison, peer benchmarks, or external news/events. Never use for figures the dataset can answer; tool output / RAG remain authoritative for the user's data. Disabled by default — returns a clear no-op message when WEB_SEARCH_ENABLED is unset.",
      argsHelp:
        '{"query": string} required, ≤500 chars. {"max_results"?: number} optional, 1–5 (default 5). Use specific phrasing ("Indian FMCG hair-oil category Q3 2024 growth") rather than vague terms.',
    }
  );
}
