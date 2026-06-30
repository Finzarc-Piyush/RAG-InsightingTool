import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Stub Azure env so any transitive import that touches the OpenAI client
// doesn't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { webSearchArgsSchema, isWebSearchEnabled, registerWebSearchTool } = await import(
  "../lib/agents/runtime/tools/webSearchTool.js"
);
const { ToolRegistry } = await import("../lib/agents/runtime/toolRegistry.js");

describe("W14 · webSearchArgsSchema", () => {
  it("accepts a minimal {query}", () => {
    const parsed = webSearchArgsSchema.parse({
      query: "Indian FMCG hair-oil category Q3 2024 growth",
    });
    assert.equal(parsed.max_results, undefined);
  });

  it("accepts an optional max_results within 1–5", () => {
    const parsed = webSearchArgsSchema.parse({
      query: "x",
      max_results: 3,
    });
    assert.equal(parsed.max_results, 3);
  });

  it("rejects max_results > 5", () => {
    assert.throws(() => webSearchArgsSchema.parse({ query: "x", max_results: 6 }));
  });

  it("rejects empty query", () => {
    assert.throws(() => webSearchArgsSchema.parse({ query: "" }));
  });

  it("rejects unknown extra keys (strict)", () => {
    assert.throws(() => webSearchArgsSchema.parse({ query: "x", deep: true }));
  });
});

describe("W14 · isWebSearchEnabled", () => {
  // W-WEB: WEB_SEARCH_ENABLED is now a DEFAULT-ON flag — unset = ON (free
  // providers, no key). It is OFF only for a canonical-falsy value
  // (0/false/no/off, case-insensitive), via `envFlagEnabledByDefault`.
  it("defaults ON when unset; OFF only for a canonical-falsy value", () => {
    const prev = process.env.WEB_SEARCH_ENABLED;
    delete process.env.WEB_SEARCH_ENABLED;
    assert.equal(isWebSearchEnabled(), true); // W-WEB · default ON
    for (const off of ["false", "0", "no", "off"]) {
      process.env.WEB_SEARCH_ENABLED = off;
      assert.equal(isWebSearchEnabled(), false, `expected OFF for ${off}`);
    }
    if (prev === undefined) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = prev;
  });

  it("is ON for any canonical-truthy WEB_SEARCH_ENABLED value", () => {
    const prev = process.env.WEB_SEARCH_ENABLED;
    for (const on of ["true", "1", "TRUE", "yes", "on"]) {
      process.env.WEB_SEARCH_ENABLED = on;
      assert.equal(isWebSearchEnabled(), true, `expected ON for ${on}`);
    }
    if (prev === undefined) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = prev;
  });
});

describe("W14 · web_search tool registration + gating", () => {
  // The ToolRegistry executor signature only needs `exec` + `config` for the
  // web_search path (it doesn't touch session data), so a minimal stub works.
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

  it("registers the `web_search` tool and exposes schema/help in the planner manifest", () => {
    const registry = new ToolRegistry();
    registerWebSearchTool(registry);
    const manifest = registry.formatToolManifestForPlanner();
    assert.match(manifest, /- web_search: Open-web search/);
    assert.match(manifest, /"query": string/);
    // Re-registering must throw (single-flow guard from F2).
    assert.throws(() => registerWebSearchTool(registry));
  });

  it("returns ok:false with a clear message when WEB_SEARCH_ENABLED is explicitly false", async () => {
    const prevEnabled = process.env.WEB_SEARCH_ENABLED;
    // W-WEB · the flag is default-ON now, so disabling requires an explicit
    // falsy value (not just unset).
    process.env.WEB_SEARCH_ENABLED = "false";
    const registry = new ToolRegistry();
    registerWebSearchTool(registry);
    const result = await registry.execute("web_search", { query: "anything" }, ctx as never);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Web search is disabled/);
    if (prevEnabled === undefined) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = prevEnabled;
  });

  it("returns ok:false with a clear message when a KEY-BEARING provider has no key", async () => {
    // R4 · only key-bearing providers (tavily) gate on a key; the default
    // keyless `auto` does not. Make the provider explicit to assert the gate.
    const prevEnabled = process.env.WEB_SEARCH_ENABLED;
    const prevKey = process.env.TAVILY_API_KEY;
    const prevProvider = process.env.WEB_SEARCH_PROVIDER;
    process.env.WEB_SEARCH_ENABLED = "true";
    process.env.WEB_SEARCH_PROVIDER = "tavily";
    delete process.env.TAVILY_API_KEY;
    const registry = new ToolRegistry();
    registerWebSearchTool(registry);
    const result = await registry.execute("web_search", { query: "anything" }, ctx as never);
    assert.equal(result.ok, false);
    assert.match(result.summary, /no provider key/);
    if (prevEnabled === undefined) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = prevEnabled;
    if (prevKey !== undefined) process.env.TAVILY_API_KEY = prevKey;
    if (prevProvider === undefined) delete process.env.WEB_SEARCH_PROVIDER;
    else process.env.WEB_SEARCH_PROVIDER = prevProvider;
  });
});
