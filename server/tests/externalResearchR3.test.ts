/**
 * Wave R3 · external research — knowledge floor, broadened external-lookup
 * detection, and the deterministic Sources bibliography.
 *
 * Asserts: (1) web_search returns a knowledge-floor instruction (not a dead
 * no-op) when disabled / no key, while keeping the W14-pinned substrings;
 * (2) detectExternalClaims now fires on explicit "search the news"-style
 * phrasings; (3) buildBibliographyBlock recovers real (title, url) pairs from
 * formatted hit blocks and dedupes by URL.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { isWebSearchEnabled, registerWebSearchTool, buildBibliographyBlock } =
  await import("../lib/agents/runtime/tools/webSearchTool.js");
const { ToolRegistry } = await import("../lib/agents/runtime/toolRegistry.js");
const { detectExternalClaims } = await import(
  "../lib/agents/runtime/utils/externalClaimDetector.js"
);

const ctx = {
  exec: {
    sessionId: "s1",
    question: "test",
    data: [] as Record<string, unknown>[],
    summary: { rowCount: 0, columnCount: 0, columns: [], numericColumns: [], dateColumns: [] },
    chatHistory: [],
    mode: "analysis",
  },
  config: { sampleRowsCap: 200, observationMaxChars: 24_000 },
  callId: "c1",
};

describe("Wave R3 · knowledge-floor guidance", () => {
  it("disabled web_search keeps the W14 substring AND adds knowledge-floor guidance", async () => {
    const prev = process.env.WEB_SEARCH_ENABLED;
    delete process.env.WEB_SEARCH_ENABLED;
    const registry = new ToolRegistry();
    registerWebSearchTool(registry);
    const result = await registry.execute("web_search", { query: "x" }, ctx as never);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Web search is disabled/); // W14 contract preserved
    assert.match(result.summary, /background knowledge/i); // R3 knowledge floor
    assert.match(result.summary, /do not invent/i);
    if (prev === undefined) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = prev;
  });

  it("tavily-but-no-key keeps the W14 substring AND adds guidance", async () => {
    const prevEnabled = process.env.WEB_SEARCH_ENABLED;
    const prevKey = process.env.TAVILY_API_KEY;
    const prevProvider = process.env.WEB_SEARCH_PROVIDER;
    process.env.WEB_SEARCH_ENABLED = "true";
    process.env.WEB_SEARCH_PROVIDER = "tavily";
    delete process.env.TAVILY_API_KEY;
    const registry = new ToolRegistry();
    registerWebSearchTool(registry);
    const result = await registry.execute("web_search", { query: "x" }, ctx as never);
    assert.equal(result.ok, false);
    assert.match(result.summary, /no provider key/);
    assert.match(result.summary, /background knowledge/i);
    if (prevEnabled === undefined) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = prevEnabled;
    if (prevKey !== undefined) process.env.TAVILY_API_KEY = prevKey;
    if (prevProvider === undefined) delete process.env.WEB_SEARCH_PROVIDER;
    else process.env.WEB_SEARCH_PROVIDER = prevProvider;
  });

  it("isWebSearchEnabled still strictly checks 'true'", () => {
    const prev = process.env.WEB_SEARCH_ENABLED;
    process.env.WEB_SEARCH_ENABLED = "true";
    assert.equal(isWebSearchEnabled(), true);
    if (prev === undefined) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = prev;
  });
});

describe("Wave R3 · external-lookup detection", () => {
  it("fires on 'search the news ...'", () => {
    const r = detectExternalClaims(
      "Search the news for what happened in Q2 that impacted sales."
    );
    assert.equal(r.hasExternalClaim, true);
    assert.ok(r.claims.some((c) => c.type === "external_lookup"));
    assert.match(r.suggestedAction!, /web_search/);
  });

  it("fires on 'latest news'", () => {
    const r = detectExternalClaims("What's the latest news on shampoo demand?");
    assert.ok(r.claims.some((c) => c.type === "external_lookup"));
  });

  it("does NOT fire on internal phrasing 'show me sales by region'", () => {
    const r = detectExternalClaims("Show me sales by region for the last quarter.");
    assert.equal(r.hasExternalClaim, false);
  });
});

describe("Wave R3 · buildBibliographyBlock", () => {
  const hits =
    "[web:gdelt:1] Retail slumped in Q2\nDemand fell after the festive season.\n— https://example.com/a\n---\n" +
    "[web:gdelt:2] Inflation hit FMCG margins\nInput costs rose 8%.\n— https://example.com/b";

  it("recovers (title, url) pairs into a numbered Sources list", () => {
    const block = buildBibliographyBlock([hits]);
    assert.match(block, /^## Sources/);
    assert.match(block, /1\. \[Retail slumped in Q2\]\(https:\/\/example\.com\/a\)/);
    assert.match(block, /2\. \[Inflation hit FMCG margins\]\(https:\/\/example\.com\/b\)/);
  });

  it("dedupes by URL across multiple blackboard entries", () => {
    const block = buildBibliographyBlock([hits, hits]);
    const occurrences = (block.match(/example\.com\/a/g) ?? []).length;
    assert.equal(occurrences, 1, "same URL listed once");
  });

  it("returns '' when there are no web sources", () => {
    assert.equal(buildBibliographyBlock([]), "");
    assert.equal(buildBibliographyBlock(["no tags or urls here"]), "");
  });
});
