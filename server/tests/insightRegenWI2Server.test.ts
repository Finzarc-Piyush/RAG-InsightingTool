import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildInsightRegenPrompt,
  extractInsightCitations,
  inferConfidenceTier,
  regenInsightForFilteredView,
  regenInsightRequestSchema,
  regenInsightResponseSchema,
  summarizeFilteredData,
} from "../lib/insightRegen.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import { __setLlmStubResolver } from "../lib/agents/runtime/callLlm.js";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const routeSrc = readFileSync(
  repoFile("../routes/insightRegen.ts"),
  "utf-8",
);
const routesIndexSrc = readFileSync(
  repoFile("../routes/index.ts"),
  "utf-8",
);
const purposeSrc = readFileSync(
  repoFile("../lib/agents/runtime/llmCallPurpose.ts"),
  "utf-8",
);

const sampleSpec = {
  type: "bar" as const,
  title: "Q3 revenue by region",
  x: "region",
  y: "revenue",
  aggregate: "sum",
};

const sampleRows: Array<Record<string, unknown>> = [
  { region: "North", revenue: 120 },
  { region: "South", revenue: 80 },
  { region: "East", revenue: 200 },
  { region: "West", revenue: 60 },
];

describe("WI2-server · regenInsightRequestSchema", () => {
  it("parses a minimal valid request", () => {
    const r = regenInsightRequestSchema.safeParse({
      tileId: "tile-1",
      spec: { type: "bar", x: "region", y: "revenue" },
      filteredData: [],
    });
    assert.equal(r.success, true);
  });

  it("parses a request with domain + dataset context", () => {
    const r = regenInsightRequestSchema.safeParse({
      tileId: "tile-1",
      spec: sampleSpec,
      filteredData: sampleRows,
      domainContext: "haircare-pack",
      datasetContextHint: "FMCG haircare weekly audit",
    });
    assert.equal(r.success, true);
  });

  it("rejects empty tileId", () => {
    const r = regenInsightRequestSchema.safeParse({
      tileId: "",
      spec: sampleSpec,
      filteredData: [],
    });
    assert.equal(r.success, false);
  });

  it("rejects extra top-level keys (strict)", () => {
    const r = regenInsightRequestSchema.safeParse({
      tileId: "tile-1",
      spec: sampleSpec,
      filteredData: [],
      unknownField: 42,
    });
    assert.equal(r.success, false);
  });

  it("rejects filteredData > 5000 rows", () => {
    const oversized = Array.from({ length: 5001 }, (_, i) => ({
      region: `R${i}`,
      revenue: i,
    }));
    const r = regenInsightRequestSchema.safeParse({
      tileId: "tile-1",
      spec: sampleSpec,
      filteredData: oversized,
    });
    assert.equal(r.success, false);
  });

  it("rejects spec missing required x/y", () => {
    const r = regenInsightRequestSchema.safeParse({
      tileId: "tile-1",
      spec: { type: "bar" } as Record<string, unknown>,
      filteredData: [],
    });
    assert.equal(r.success, false);
  });
});

describe("WI2-server · regenInsightResponseSchema", () => {
  it("parses a full response", () => {
    const r = regenInsightResponseSchema.safeParse({
      text: "North leads at 200; West trails at 60.",
      citations: ["fmcg-glossary"],
      regeneratedAt: "2026-05-18T12:00:00.000Z",
      confidenceTier: "medium",
    });
    assert.equal(r.success, true);
  });

  it("accepts response without citations", () => {
    const r = regenInsightResponseSchema.safeParse({
      text: "x",
      regeneratedAt: "2026-05-18T12:00:00.000Z",
      confidenceTier: "low",
    });
    assert.equal(r.success, true);
  });

  it("rejects invalid confidenceTier", () => {
    const r = regenInsightResponseSchema.safeParse({
      text: "x",
      regeneratedAt: "2026-05-18T12:00:00.000Z",
      confidenceTier: "great" as never,
    });
    assert.equal(r.success, false);
  });
});

describe("WI2-server · summarizeFilteredData", () => {
  it("returns zero summary on empty input", () => {
    const s = summarizeFilteredData([], { x: "region", y: "revenue" });
    assert.deepEqual(s, {
      rowCount: 0,
      topRow: null,
      bottomRow: null,
      mean: null,
      xValuesPreview: [],
    });
  });

  it("computes top / bottom / mean", () => {
    const s = summarizeFilteredData(sampleRows, { x: "region", y: "revenue" });
    assert.equal(s.rowCount, 4);
    assert.deepEqual(s.topRow, { x: "East", y: 200 });
    assert.deepEqual(s.bottomRow, { x: "West", y: 60 });
    assert.equal(s.mean, (120 + 80 + 200 + 60) / 4);
  });

  it("collects distinct x-values in encountered order, capped at 6", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      region: `R${i}`,
      revenue: i,
    }));
    const s = summarizeFilteredData(rows, { x: "region", y: "revenue" });
    assert.deepEqual(s.xValuesPreview, ["R0", "R1", "R2", "R3", "R4", "R5"]);
  });

  it("coerces percent / comma-formatted strings via toNumberOrNull", () => {
    const rows = [
      { region: "A", revenue: "1,200" },
      { region: "B", revenue: "85%" },
    ];
    const s = summarizeFilteredData(rows, { x: "region", y: "revenue" });
    assert.equal(s.topRow?.y, 1200);
    assert.equal(s.bottomRow?.y, 85);
  });

  it("skips non-numeric y cells without poisoning the mean", () => {
    const rows = [
      { region: "A", revenue: 10 },
      { region: "B", revenue: "not a number" },
      { region: "C", revenue: 20 },
    ];
    const s = summarizeFilteredData(rows, { x: "region", y: "revenue" });
    assert.equal(s.mean, 15);
    assert.equal(s.topRow?.y, 20);
  });

  it("renders null x-values as (null)", () => {
    const rows = [
      { region: null, revenue: 5 },
      { region: "A", revenue: 10 },
    ];
    const s = summarizeFilteredData(rows, { x: "region", y: "revenue" });
    assert.deepEqual(s.xValuesPreview, ["(null)", "A"]);
  });
});

describe("WI2-server · inferConfidenceTier", () => {
  it("returns low for <10 rows", () => {
    assert.equal(inferConfidenceTier(0), "low");
    assert.equal(inferConfidenceTier(9), "low");
  });
  it("returns medium for 10..99", () => {
    assert.equal(inferConfidenceTier(10), "medium");
    assert.equal(inferConfidenceTier(99), "medium");
  });
  it("returns high for ≥100", () => {
    assert.equal(inferConfidenceTier(100), "high");
    assert.equal(inferConfidenceTier(5000), "high");
  });
});

describe("WI2-server · extractInsightCitations", () => {
  it("extracts backticked snake-case pack ids with hyphens", () => {
    const text =
      "North outperforms per `fmcg-glossary` and `regional-benchmarks-2025`.";
    assert.deepEqual(extractInsightCitations(text), [
      "fmcg-glossary",
      "regional-benchmarks-2025",
    ]);
  });
  it("rejects backticked tokens without a hyphen", () => {
    const text = "The value `revenue` is high.";
    assert.deepEqual(extractInsightCitations(text), []);
  });
  it("dedupes repeated citations preserving first occurrence", () => {
    const text = "Per `pack-one`, `pack-two`, and `pack-one` again.";
    assert.deepEqual(extractInsightCitations(text), ["pack-one", "pack-two"]);
  });
  it("returns [] for empty / whitespace", () => {
    assert.deepEqual(extractInsightCitations(""), []);
    assert.deepEqual(extractInsightCitations("   "), []);
  });
});

describe("WI2-server · buildInsightRegenPrompt", () => {
  it("returns byte-stable system prompt across calls", () => {
    const a = buildInsightRegenPrompt({
      spec: sampleSpec,
      summary: summarizeFilteredData(sampleRows, { x: "region", y: "revenue" }),
    });
    const b = buildInsightRegenPrompt({
      spec: sampleSpec,
      summary: summarizeFilteredData(sampleRows, { x: "region", y: "revenue" }),
    });
    assert.equal(a.system, b.system);
    assert.equal(a.user, b.user);
  });

  it("user block names chart spec coordinates verbatim", () => {
    const p = buildInsightRegenPrompt({
      spec: sampleSpec,
      summary: summarizeFilteredData(sampleRows, { x: "region", y: "revenue" }),
    });
    assert.match(p.user, /- type: bar/);
    assert.match(p.user, /- x: region/);
    assert.match(p.user, /- y: revenue/);
    assert.match(p.user, /- title: Q3 revenue by region/);
  });

  it("user block embeds the deterministic summary anchors", () => {
    const summary = summarizeFilteredData(sampleRows, {
      x: "region",
      y: "revenue",
    });
    const p = buildInsightRegenPrompt({ spec: sampleSpec, summary });
    assert.match(p.user, /rowCount: 4/);
    assert.match(p.user, /top: region="East"/);
    assert.match(p.user, /bottom: region="West"/);
  });

  it("emits DOMAIN CONTEXT block only when populated", () => {
    const summary = summarizeFilteredData(sampleRows, {
      x: "region",
      y: "revenue",
    });
    const withCtx = buildInsightRegenPrompt({
      spec: sampleSpec,
      summary,
      domainContext: "haircare-pack details",
    });
    assert.match(withCtx.user, /DOMAIN CONTEXT:\nhaircare-pack details/);

    const without = buildInsightRegenPrompt({ spec: sampleSpec, summary });
    assert.equal(without.user.includes("DOMAIN CONTEXT"), false);
  });

  it("emits DATASET CONTEXT block only when populated", () => {
    const summary = summarizeFilteredData(sampleRows, {
      x: "region",
      y: "revenue",
    });
    const withHint = buildInsightRegenPrompt({
      spec: sampleSpec,
      summary,
      datasetContextHint: "FMCG haircare weekly retail audit",
    });
    assert.match(
      withHint.user,
      /DATASET CONTEXT: FMCG haircare weekly retail audit/,
    );

    const without = buildInsightRegenPrompt({ spec: sampleSpec, summary });
    assert.equal(without.user.includes("DATASET CONTEXT"), false);
  });

  it("ignores blank / whitespace-only context strings", () => {
    const summary = summarizeFilteredData(sampleRows, {
      x: "region",
      y: "revenue",
    });
    const p = buildInsightRegenPrompt({
      spec: sampleSpec,
      summary,
      domainContext: "   ",
      datasetContextHint: "",
    });
    assert.equal(p.user.includes("DOMAIN CONTEXT"), false);
    assert.equal(p.user.includes("DATASET CONTEXT"), false);
  });
});

describe("WI2-server · regenInsightForFilteredView (LLM stub)", () => {
  it("returns the model output with citations + tier + ISO timestamp", async () => {
    __setLlmStubResolver((params, opts) => {
      assert.equal(opts.purpose, LLM_PURPOSE.INSIGHT_REGEN);
      // System prompt must be the one buildInsightRegenPrompt emits.
      const sys = params.messages[0];
      assert.equal(sys.role, "system");
      assert.match(String(sys.content), /analytical insight summariser/);
      return {
        id: "stub",
        object: "chat.completion",
        created: 0,
        model: params.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "East leads at 200 (avg 115) per `fmcg-glossary`. West trails at 60 — investigate distribution.",
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      } as unknown as ReturnType<NonNullable<Parameters<typeof __setLlmStubResolver>[0]>>;
    });
    try {
      const out = await regenInsightForFilteredView({
        tileId: "tile-1",
        spec: sampleSpec,
        filteredData: sampleRows,
      });
      assert.match(out.text, /East leads/);
      assert.deepEqual(out.citations, ["fmcg-glossary"]);
      assert.equal(out.confidenceTier, "low"); // 4 rows < 10
      assert.match(out.regeneratedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      __setLlmStubResolver(null);
    }
  });

  it("falls back to default prose when the model returns empty content", async () => {
    __setLlmStubResolver((params) => ({
      id: "stub",
      object: "chat.completion",
      created: 0,
      model: params.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 },
    } as unknown as ReturnType<NonNullable<Parameters<typeof __setLlmStubResolver>[0]>>));
    try {
      const out = await regenInsightForFilteredView({
        tileId: "tile-2",
        spec: sampleSpec,
        filteredData: sampleRows,
      });
      assert.match(out.text, /Not enough signal/);
      assert.equal(out.citations, undefined);
    } finally {
      __setLlmStubResolver(null);
    }
  });

  it("infers high tier for ≥100 rows", async () => {
    const bigRows = Array.from({ length: 150 }, (_, i) => ({
      region: `R${i % 5}`,
      revenue: i * 2,
    }));
    __setLlmStubResolver((params) => ({
      id: "stub",
      object: "chat.completion",
      created: 0,
      model: params.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    } as unknown as ReturnType<NonNullable<Parameters<typeof __setLlmStubResolver>[0]>>));
    try {
      const out = await regenInsightForFilteredView({
        tileId: "tile-3",
        spec: sampleSpec,
        filteredData: bigRows,
      });
      assert.equal(out.confidenceTier, "high");
    } finally {
      __setLlmStubResolver(null);
    }
  });
});

describe("WI2-server · route + purpose wiring (source-inspection)", () => {
  it("routes/insightRegen.ts registers POST /insight/regen", () => {
    assert.match(routeSrc, /router\.post\(\s*"\/insight\/regen"\s*,\s*insightRegenController\s*\)/);
  });

  it("routes/insightRegen.ts uses regenInsightRequestSchema for body validation", () => {
    assert.match(routeSrc, /regenInsightRequestSchema\.safeParse\(req\.body\)/);
  });

  it("routes/insightRegen.ts gates on getAuthenticatedEmail", () => {
    assert.match(routeSrc, /getAuthenticatedEmail\(req\)/);
  });

  it("routes/index.ts imports + mounts insightRegenRoutes under /api", () => {
    assert.match(
      routesIndexSrc,
      /import insightRegenRoutes from "\.\/insightRegen\.js"/,
    );
    // API-7: mounted via `mount('', insightRegenRoutes)` → `/api` + `/api/v1`.
    assert.match(routesIndexSrc, /mount\(\s*['"]['"]\s*,\s*insightRegenRoutes\s*\)/);
  });

  it("LLM_PURPOSE includes INSIGHT_REGEN mapped to MINI", () => {
    assert.match(purposeSrc, /INSIGHT_REGEN:\s*"insight_regen"/);
    assert.match(
      purposeSrc,
      /\[LLM_PURPOSE\.INSIGHT_REGEN\]:\s*"MINI"/,
    );
  });
});
