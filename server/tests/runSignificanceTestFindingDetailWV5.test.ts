/**
 * Wave WV5 · `run_significance_test` migrated to WV2's `composeFindingDetail`.
 *
 * Second per-tool migration in the WV4 series. p-value is the load-bearing
 * statistical evidence for significance tests; total sample size pairs with
 * it for WQ1's tier classifier. Once the suffix lands on the tool's success
 * summary, the downstream blackboard `addFinding` carries it into the
 * finding's `detail` and the WW2 extractor catches both fields
 * deterministically.
 *
 * Coverage:
 *  - All three test branches (welch_t / paired_t / chi_square) now produce a
 *    summary string that ends with the canonical evidence suffix.
 *  - Roundtrip property: extractFindingEvidence on the full summary recovers
 *    p-value + n.
 *  - Source-inspection wiring: significanceTestTool.ts imports the WV2
 *    formatter, defines `buildEvidenceSuffix`, and appends it at each of the
 *    three success-path returns.
 *
 * The tool's `runSignificanceTest` dependency is pure (math-only, no LLM),
 * so we can drive the registered tool end-to-end with real frames. Avoids
 * relying on source-only inspection for behavioural coverage.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

process.env.SIGNIFICANCE_TESTS_ENABLED = "true";
process.env.AGENTIC_ALLOW_NO_RAG = process.env.AGENTIC_ALLOW_NO_RAG ?? "true";
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { ToolRegistry } = await import("../lib/agents/runtime/toolRegistry.js");
const { registerSignificanceTestTool } = await import(
  "../lib/agents/runtime/tools/significanceTestTool.js"
);
const { extractFindingEvidence } = await import(
  "../lib/agents/runtime/narratorHintsBlock.js"
);

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeCtx(opts: {
  data: Record<string, any>[];
  numericColumns: string[];
  schemaColumns?: string[];
}) {
  const schemaNames =
    opts.schemaColumns ?? [...opts.numericColumns, "group"];
  const cols = schemaNames.map((name) => ({
    name,
    type: opts.numericColumns.includes(name) ? "number" : "string",
    sampleValues: [],
  }));
  return {
    exec: {
      sessionId: "s-wv5",
      question: "is the difference significant?",
      data: opts.data,
      turnStartDataRef: opts.data,
      summary: {
        rowCount: opts.data.length,
        columnCount: cols.length,
        columns: cols,
        numericColumns: opts.numericColumns,
        dateColumns: [],
      },
      chatInsights: [],
      chatHistory: [],
      mode: "analysis",
    },
    config: { sampleRowsCap: 1000, observationMaxChars: 24_000 },
    callId: "c-wv5",
  };
}

describe("Wave WV5 · run_significance_test emits canonical FindingEvidence suffix (welch_t)", () => {
  it("welch_t success summary ends with ' (n = N; p = X)' where N = nA + nB", async () => {
    const registry = new ToolRegistry();
    registerSignificanceTestTool(registry);
    // 30 rows in group A with value ≈ 10, 30 rows in group B with value ≈ 20.
    // Large difference → highly significant p; n = 60.
    const data: Record<string, any>[] = [];
    for (let i = 0; i < 30; i++) data.push({ value: 10 + (i % 3), group: "A" });
    for (let i = 0; i < 30; i++) data.push({ value: 20 + (i % 3), group: "B" });
    const ctx = makeCtx({ data, numericColumns: ["value"], schemaColumns: ["value", "group"] });
    const result = await registry.execute(
      "run_significance_test",
      {
        test: "welch_t",
        valueColumn: "value",
        groupAFilters: [{ column: "group", op: "in", values: ["A"] }],
        groupBFilters: [{ column: "group", op: "in", values: ["B"] }],
      },
      ctx as never,
    );
    assert.equal(result.ok, true);
    // Suffix ends the summary; n = 60 (30 + 30); p is very small (highly significant).
    assert.match(result.summary, / \(n = 60; (?:p = [0-9.]+|p < 0\.001)\)$/);
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.n, 60, "n recovered from suffix");
    assert.ok(recovered.pValue !== undefined, "p recovered from interpretation or suffix");
  });
});

describe("Wave WV5 · run_significance_test emits canonical FindingEvidence suffix (paired_t)", () => {
  it("paired_t success summary carries n = pair count + p", async () => {
    const registry = new ToolRegistry();
    registerSignificanceTestTool(registry);
    const N = 25;
    const data = Array.from({ length: N }, (_, i) => ({
      before: 100 + i,
      after: 110 + i, // consistent +10
    }));
    const ctx = makeCtx({
      data,
      numericColumns: ["before", "after"],
      schemaColumns: ["before", "after"],
    });
    const result = await registry.execute(
      "run_significance_test",
      { test: "paired_t", columnA: "before", columnB: "after" },
      ctx as never,
    );
    assert.equal(result.ok, true);
    assert.match(result.summary, / \(n = 25; (?:p = [0-9.]+|p < 0\.001)\)$/);
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.n, 25);
    assert.ok(recovered.pValue !== undefined);
  });
});

describe("Wave WV5 · run_significance_test emits canonical FindingEvidence suffix (chi_square)", () => {
  it("chi_square success summary carries n = grand total + p", async () => {
    const registry = new ToolRegistry();
    registerSignificanceTestTool(registry);
    // 2x2 contingency with clear association → significant p.
    const contingencyTable = [
      [50, 10],
      [10, 50],
    ];
    const grandTotal = 50 + 10 + 10 + 50;
    const ctx = makeCtx({
      data: [],
      numericColumns: [],
      schemaColumns: ["whatever"],
    });
    const result = await registry.execute(
      "run_significance_test",
      { test: "chi_square", contingencyTable },
      ctx as never,
    );
    assert.equal(result.ok, true);
    assert.match(
      result.summary,
      new RegExp(` \\(n = ${grandTotal}; (?:p = [0-9.]+|p < 0\\.001)\\)$`),
    );
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.n, grandTotal);
    assert.ok(recovered.pValue !== undefined);
  });
});

describe("Wave WV5 · source-inspection wiring", () => {
  it("significanceTestTool.ts imports composeFindingDetail + FindingEvidence and defines buildEvidenceSuffix", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/tools/significanceTestTool.ts"),
      "utf8",
    );
    assert.ok(
      src.includes('from "../formatFindingEvidence.js"'),
      "significanceTestTool.ts must import composeFindingDetail",
    );
    assert.ok(
      src.includes("import type { FindingEvidence }"),
      "significanceTestTool.ts must import the FindingEvidence type",
    );
    assert.ok(
      src.includes("function buildEvidenceSuffix("),
      "must define the buildEvidenceSuffix helper",
    );
  });

  it("all three success-path summaries call buildEvidenceSuffix", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/tools/significanceTestTool.ts"),
      "utf8",
    );
    // Count the call sites. Three test branches → three calls.
    const callCount = (src.match(/buildEvidenceSuffix\(/g) ?? []).length;
    // 1 definition + 3 call sites = 4 occurrences of `buildEvidenceSuffix(` total.
    assert.ok(
      callCount >= 4,
      `expected ≥4 occurrences of buildEvidenceSuffix( (1 def + 3 calls), saw ${callCount}`,
    );
  });
});
