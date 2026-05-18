import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSemanticCatalogPromptBlock } from "../lib/semantic/prompt.js";
import type {
  SemanticDimension,
  SemanticMetric,
  SemanticModel,
} from "../shared/schema.js";

function metric(over: Partial<SemanticMetric> = {}): SemanticMetric {
  return {
    name: "value_sales",
    label: "Value Sales",
    expression: "SUM(value_sales)",
    references: ["value_sales"],
    format: "currency",
    currencyCode: "INR",
    exposed: true,
    source: "auto",
    ...over,
  };
}

function dimension(over: Partial<SemanticDimension> = {}): SemanticDimension {
  return {
    name: "region",
    label: "Region",
    column: "region",
    kind: "categorical",
    exposed: true,
    source: "auto",
    ...over,
  };
}

function model(over: Partial<SemanticModel> = {}): SemanticModel {
  return {
    version: 1,
    name: "test-model",
    metrics: [],
    dimensions: [],
    hierarchies: [],
    ...over,
  };
}

describe("W59b · buildSemanticCatalogPromptBlock — null/undefined input", () => {
  it("returns the empty string when the model is null", () => {
    assert.equal(buildSemanticCatalogPromptBlock(null), "");
  });

  it("returns the empty string when the model is undefined", () => {
    assert.equal(buildSemanticCatalogPromptBlock(undefined), "");
  });
});

describe("W59b · buildSemanticCatalogPromptBlock — populated model", () => {
  it("renders the manifest followed by a paragraph break (\\n\\n)", () => {
    const out = buildSemanticCatalogPromptBlock(
      model({ metrics: [metric()], dimensions: [dimension()] }),
    );
    assert.ok(out.startsWith("## Semantic catalog"), "starts with manifest header");
    assert.ok(out.endsWith("\n\n"), "ends with paragraph break");
    assert.match(out, /value_sales/);
    assert.match(out, /region/);
  });

  it("renders the empty-marker manifest when the model has no exposed entries", () => {
    const out = buildSemanticCatalogPromptBlock(model({ version: 5 }));
    assert.ok(out.endsWith("\n\n"));
    assert.match(out, /^## Semantic catalog \(v5\)$/m);
    assert.match(out, /_\(empty —/);
  });
});

describe("W59b · buildSemanticCatalogPromptBlock — options pass-through", () => {
  it("forwards includeHidden to formatMetricCatalog", () => {
    const m = model({
      metrics: [
        metric({ name: "public_metric", exposed: true }),
        metric({ name: "draft_metric", exposed: false }),
      ],
    });
    const def = buildSemanticCatalogPromptBlock(m);
    assert.equal(def.includes("draft_metric"), false);

    const full = buildSemanticCatalogPromptBlock(m, { includeHidden: true });
    assert.match(full, /draft_metric/);
  });
});

describe("W59b · buildSemanticCatalogPromptBlock — byte stability", () => {
  it("produces identical output for two identical models", () => {
    const a = buildSemanticCatalogPromptBlock(
      model({ metrics: [metric()], dimensions: [dimension()] }),
    );
    const b = buildSemanticCatalogPromptBlock(
      model({ metrics: [metric()], dimensions: [dimension()] }),
    );
    assert.equal(a, b);
  });
});

describe("W59b · planner.ts source-inspection wiring", () => {
  const plannerSrc = readFileSync(
    resolve(
      new URL("../lib/agents/runtime/planner.ts", import.meta.url).pathname,
    ),
    "utf-8",
  );

  it("imports buildSemanticCatalogPromptBlock from server/lib/semantic/prompt.js", () => {
    assert.match(
      plannerSrc,
      /import \{ buildSemanticCatalogPromptBlock \} from "\.\.\/\.\.\/semantic\/prompt\.js"/,
    );
  });

  it("calls buildSemanticCatalogPromptBlock with ctx.chatDocument?.semanticModel", () => {
    assert.match(
      plannerSrc,
      /buildSemanticCatalogPromptBlock\(\s*ctx\.chatDocument\?\.semanticModel\s*\)/,
    );
  });

  it("inlines ${semanticBlock} between ${hintsResult.block} and ${ragBlock} in the user prompt template", () => {
    assert.match(
      plannerSrc,
      /\$\{hintsResult\.block\}\$\{semanticBlock\}\$\{ragBlock\}/,
    );
  });
});
