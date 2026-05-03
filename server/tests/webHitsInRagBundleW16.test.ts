import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DataSummary } from "../shared/schema.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import {
  createBlackboard,
  addDomainContext,
  type DomainContextEntry,
} from "../lib/agents/runtime/analyticalBlackboard.js";

// Stub Azure env so transitive openai imports don't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { buildSynthesisContext, formatSynthesisContextBundle } = await import(
  "../lib/agents/runtime/buildSynthesisContext.js"
);

const summary: DataSummary = {
  rowCount: 100,
  columnCount: 3,
  columns: [
    { name: "Brand", type: "string", sampleValues: [] },
    { name: "Volume_MT", type: "number", sampleValues: [] },
    { name: "Month", type: "date", sampleValues: [] },
  ],
  numericColumns: ["Volume_MT"],
  dateColumns: ["Month"],
};

const minimalCtx = (): AgentExecutionContext => ({
  sessionId: "s1",
  question: "How does our Q3 share compare to industry?",
  data: [],
  summary,
  chatHistory: [],
  mode: "analysis",
});

describe("W16 · DomainContextEntry source enum accepts 'web'", () => {
  it("addDomainContext stores `web` source entries", () => {
    const bb = createBlackboard();
    const entry = addDomainContext(bb, "[web:tavily:1] Industry growth was 4%", "web");
    assert.equal(entry.source, "web");
    assert.equal(bb.domainContext.length, 1);
    assert.equal(bb.domainContext[0].source, "web");
  });

  it("type system accepts the new union member", () => {
    const e: DomainContextEntry = { id: "x", content: "y", source: "web" };
    assert.equal(e.source, "web");
  });
});

describe("W16 · ragBlock includes web sub-section", () => {
  it("emits `# Web search context` when web entries exist", () => {
    const bb = createBlackboard();
    addDomainContext(
      bb,
      "[web:tavily:1] Hair-oil category Q3 growth\nIndian hair-oil market grew ~4% YoY in Q3 per industry trackers.\n— https://example.com/report",
      "web"
    );
    const bundle = buildSynthesisContext(minimalCtx(), { blackboard: bb });
    assert.match(bundle.ragBlock, /# Web search context/);
    assert.match(bundle.ragBlock, /\[web:tavily:1\] Hair-oil category/);
    assert.match(bundle.ragBlock, /https:\/\/example\.com/);
  });

  it("does not emit `# Web search context` when no web entries", () => {
    const bb = createBlackboard();
    addDomainContext(bb, "round-2 only", "rag_round2");
    const bundle = buildSynthesisContext(minimalCtx(), { blackboard: bb });
    assert.ok(!/Web search context/.test(bundle.ragBlock));
  });

  it("renders all three sub-sections in stable order: round-1, round-2, web", () => {
    const bb = createBlackboard();
    addDomainContext(bb, "round-2 hit body", "rag_round2");
    addDomainContext(bb, "[web:tavily:1] web hit body\n— https://example.com", "web");
    const bundle = buildSynthesisContext(minimalCtx(), {
      upfrontRagHitsBlock: "[summary:s1]\nupfront hit body\n",
      blackboard: bb,
    });
    const block = bundle.ragBlock;
    const r1 = block.indexOf("# Upfront retrieval (round 1)");
    const r2 = block.indexOf("# Findings-driven retrieval (round 2)");
    const web = block.indexOf("# Web search context");
    assert.ok(r1 >= 0 && r2 > r1 && web > r2, `expected order r1<r2<web; got r1=${r1} r2=${r2} web=${web}`);
  });

  it("respects the WTL2-bumped 9_000-char cap (was W16: 6k)", () => {
    const bb = createBlackboard();
    // 8 × 1.5k chars of web content = 12k pre-cap; truncated to ≤9k.
    for (let i = 0; i < 8; i++) {
      addDomainContext(bb, `[web:tavily:${i + 1}] ${"x".repeat(1500)}`, "web");
    }
    const bundle = buildSynthesisContext(minimalCtx(), { blackboard: bb });
    assert.ok(bundle.ragBlock.length <= 9_000, `ragBlock=${bundle.ragBlock.length} > 9000`);
  });
});

describe("W16 · formatSynthesisContextBundle relabels RAG section as RAG / web", () => {
  it("section header reads 'RELATED CONTEXT (RAG / web)' when web hits present", () => {
    const bb = createBlackboard();
    addDomainContext(bb, "[web:tavily:1] x\n— https://e.com", "web");
    const out = formatSynthesisContextBundle(buildSynthesisContext(minimalCtx(), { blackboard: bb }));
    assert.match(out, /## RELATED CONTEXT \(RAG \/ web\)/);
    assert.match(out, /tavily:N/); // help text still references the tag form
  });

  it("section header still reads 'RELATED CONTEXT (RAG / web)' even with only RAG hits (label is stable)", () => {
    const bb = createBlackboard();
    addDomainContext(bb, "round-2 only", "rag_round2");
    const out = formatSynthesisContextBundle(buildSynthesisContext(minimalCtx(), { blackboard: bb }));
    assert.match(out, /## RELATED CONTEXT \(RAG \/ web\)/);
  });
});
