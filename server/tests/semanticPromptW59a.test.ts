import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatMetricCatalog,
  formatMetricLines,
  formatDimensionLines,
  formatHierarchyLines,
} from "../lib/semantic/prompt.js";
import type {
  SemanticDimension,
  SemanticHierarchy,
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

function hierarchy(over: Partial<SemanticHierarchy> = {}): SemanticHierarchy {
  return {
    name: "geo",
    label: "Geography",
    levels: ["country", "region", "city"],
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

describe("W59a · formatMetricCatalog — empty model", () => {
  it("renders a stable empty marker when no metrics / dimensions / hierarchies are present", () => {
    const out = formatMetricCatalog(model({ version: 3 }));
    assert.match(out, /^## Semantic catalog \(v3\)$/m);
    assert.match(out, /_\(empty — no metrics, dimensions, or hierarchies/);
    assert.equal(out.includes("### Metrics"), false);
  });

  it("treats a model with only hidden entries as empty", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [metric({ exposed: false })],
        dimensions: [dimension({ exposed: false })],
      }),
    );
    assert.match(out, /\(empty —/);
  });
});

describe("W59a · formatMetricCatalog — metrics section", () => {
  it("renders a single currency metric with code + label + expression + format hint", () => {
    const out = formatMetricCatalog(
      model({ metrics: [metric({ decimals: 2 })] }),
    );
    assert.match(out, /### Metrics \(1\)/);
    assert.match(out, /- `value_sales` — Value Sales/);
    assert.match(out, /Expression: `SUM\(value_sales\)`/);
    assert.match(out, /Format: currency \(INR\), 2 dp/);
    assert.match(out, /References: value_sales/);
  });

  it("sorts metrics alphabetically by name regardless of input order", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [
          metric({ name: "z_metric", label: "Z", expression: "SUM(z)" }),
          metric({ name: "a_metric", label: "A", expression: "SUM(a)" }),
          metric({ name: "m_metric", label: "M", expression: "SUM(m)" }),
        ],
      }),
    );
    const aPos = out.indexOf("`a_metric`");
    const mPos = out.indexOf("`m_metric`");
    const zPos = out.indexOf("`z_metric`");
    assert.ok(aPos > 0 && aPos < mPos && mPos < zPos, "expected a < m < z");
  });

  it("hides exposed=false metrics by default and shows them with includeHidden", () => {
    const m = model({
      metrics: [
        metric({ name: "public_metric", exposed: true }),
        metric({ name: "draft_metric", exposed: false }),
      ],
    });
    const def = formatMetricCatalog(m);
    assert.match(def, /public_metric/);
    assert.equal(def.includes("draft_metric"), false);
    assert.match(def, /### Metrics \(1\)/);

    const full = formatMetricCatalog(m, { includeHidden: true });
    assert.match(full, /draft_metric/);
    assert.match(full, /### Metrics \(2\)/);
  });

  it("omits the References line when references array is empty", () => {
    const out = formatMetricCatalog(
      model({ metrics: [metric({ references: [] })] }),
    );
    assert.equal(out.includes("References:"), false);
  });

  it("renders non-currency formats without the parenthetical code", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [
          metric({
            name: "share",
            label: "Share",
            expression: "AVG(share)",
            format: "percent",
            currencyCode: undefined,
            references: [],
          }),
        ],
      }),
    );
    assert.match(out, /Format: percent/);
    assert.equal(out.includes("currency"), false);
  });

  it("collapses multi-line descriptions onto a single line", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [
          metric({
            description: "line one\n\n  line two\n\nline three",
            references: [],
          }),
        ],
      }),
    );
    assert.match(out, /line one line two line three/);
    assert.equal(out.includes("line one\nline two"), false);
  });
});

describe("W59a · formatMetricCatalog — dimensions section", () => {
  it("renders categorical dimensions without a grain qualifier", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [metric()],
        dimensions: [dimension({ kind: "categorical" })],
      }),
    );
    assert.match(out, /### Dimensions \(1\)/);
    assert.match(out, /- `region` — Region/);
    assert.match(out, /Kind: categorical$/m);
  });

  it("renders temporal dimensions with grain in parentheses", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [metric()],
        dimensions: [
          dimension({
            name: "month",
            label: "Month",
            column: "date",
            kind: "temporal",
            temporalGrain: "month",
          }),
        ],
      }),
    );
    assert.match(out, /Kind: temporal \(month\)/);
  });

  it("sorts dimensions alphabetically by name", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [metric()],
        dimensions: [
          dimension({ name: "zone" }),
          dimension({ name: "channel" }),
          dimension({ name: "brand" }),
        ],
      }),
    );
    const brandPos = out.indexOf("`brand`");
    const channelPos = out.indexOf("`channel`");
    const zonePos = out.indexOf("`zone`");
    assert.ok(
      brandPos > 0 && brandPos < channelPos && channelPos < zonePos,
      "expected brand < channel < zone",
    );
  });
});

describe("W59a · formatMetricCatalog — hierarchies section", () => {
  it("renders levels joined with arrows", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [metric()],
        hierarchies: [hierarchy()],
      }),
    );
    assert.match(out, /### Hierarchies \(1\)/);
    assert.match(out, /Levels: country → region → city/);
  });

  it("sorts hierarchies alphabetically by name", () => {
    const out = formatMetricCatalog(
      model({
        metrics: [metric()],
        hierarchies: [
          hierarchy({ name: "z_h", levels: ["a", "b"] }),
          hierarchy({ name: "a_h", levels: ["a", "b"] }),
        ],
      }),
    );
    const aPos = out.indexOf("`a_h`");
    const zPos = out.indexOf("`z_h`");
    assert.ok(aPos > 0 && aPos < zPos, "expected a_h before z_h");
  });
});

describe("W59a · formatMetricCatalog — byte stability", () => {
  it("produces identical output for two identical models", () => {
    const a = formatMetricCatalog(
      model({ metrics: [metric()], dimensions: [dimension()] }),
    );
    const b = formatMetricCatalog(
      model({ metrics: [metric()], dimensions: [dimension()] }),
    );
    assert.equal(a, b);
  });

  it("ignores input order — same model in different order yields identical output", () => {
    const a = formatMetricCatalog(
      model({
        metrics: [
          metric({ name: "alpha", expression: "SUM(a)", references: ["a"] }),
          metric({ name: "beta", expression: "SUM(b)", references: ["b"] }),
        ],
        dimensions: [
          dimension({ name: "channel" }),
          dimension({ name: "region" }),
        ],
      }),
    );
    const b = formatMetricCatalog(
      model({
        metrics: [
          metric({ name: "beta", expression: "SUM(b)", references: ["b"] }),
          metric({ name: "alpha", expression: "SUM(a)", references: ["a"] }),
        ],
        dimensions: [
          dimension({ name: "region" }),
          dimension({ name: "channel" }),
        ],
      }),
    );
    assert.equal(a, b);
  });
});

describe("W59a · formatMetricCatalog — section heading toggle", () => {
  it("omits section heading lines when includeSectionHeadings=false", () => {
    const out = formatMetricCatalog(
      model({ metrics: [metric()], dimensions: [dimension()] }),
      { includeSectionHeadings: false },
    );
    assert.equal(out.includes("### Metrics"), false);
    assert.equal(out.includes("### Dimensions"), false);
    assert.match(out, /- `value_sales`/);
    assert.match(out, /- `region`/);
  });
});

describe("W59a · formatMetric/Dimension/Hierarchy lines — direct helpers", () => {
  it("formatMetricLines emits a stable block for a single metric", () => {
    const lines = formatMetricLines(metric());
    assert.deepEqual(lines, [
      "- `value_sales` — Value Sales",
      "  - Expression: `SUM(value_sales)`",
      "  - Format: currency (INR)",
      "  - References: value_sales",
      "",
    ]);
  });

  it("formatDimensionLines emits a stable block for a single dimension", () => {
    const lines = formatDimensionLines(
      dimension({ description: "Sales region (north/south/east/west)" }),
    );
    assert.deepEqual(lines, [
      "- `region` — Region",
      "  - Column: `region`",
      "  - Kind: categorical",
      "  - Sales region (north/south/east/west)",
      "",
    ]);
  });

  it("formatHierarchyLines emits a stable block for a single hierarchy", () => {
    const lines = formatHierarchyLines(hierarchy());
    assert.deepEqual(lines, [
      "- `geo` — Geography",
      "  - Levels: country → region → city",
      "",
    ]);
  });
});
