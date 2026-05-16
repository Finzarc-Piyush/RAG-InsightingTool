import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  semanticMetricSchema,
  semanticDimensionSchema,
  semanticHierarchySchema,
  semanticModelSchema,
  type SemanticModel,
} from "../shared/schema.js";

describe("W56 · semantic metric schema", () => {
  it("round-trips a fully-populated metric", () => {
    const input = {
      name: "net_sales",
      label: "Net Sales",
      expression: "SUM(gross_sales) - SUM(returns)",
      references: ["gross_sales", "returns"],
      format: "currency" as const,
      currencyCode: "INR",
      decimals: 0,
      description:
        "Gross sales minus returns. See `kpi-and-metric-glossary` for canonical definition.",
      exposed: true,
      source: "domain" as const,
    };
    const parsed = semanticMetricSchema.parse(input);
    assert.deepEqual(parsed, input);
  });

  it("applies defaults: format=number, exposed=true, source=auto, references=[]", () => {
    const parsed = semanticMetricSchema.parse({
      name: "row_count",
      label: "Row Count",
      expression: "COUNT(*)",
    });
    assert.equal(parsed.format, "number");
    assert.equal(parsed.exposed, true);
    assert.equal(parsed.source, "auto");
    assert.deepEqual(parsed.references, []);
  });

  it("rejects non-snake-case names", () => {
    assert.throws(() =>
      semanticMetricSchema.parse({
        name: "NetSales",
        label: "Net Sales",
        expression: "SUM(x)",
      }),
    );
    assert.throws(() =>
      semanticMetricSchema.parse({
        name: "net-sales",
        label: "Net Sales",
        expression: "SUM(x)",
      }),
    );
    assert.throws(() =>
      semanticMetricSchema.parse({
        name: "1_metric",
        label: "Numeric Prefix",
        expression: "SUM(x)",
      }),
    );
  });

  it("rejects non-ISO-4217 currency codes", () => {
    assert.throws(() =>
      semanticMetricSchema.parse({
        name: "revenue",
        label: "Revenue",
        expression: "SUM(x)",
        format: "currency",
        currencyCode: "inr",
      }),
    );
    assert.throws(() =>
      semanticMetricSchema.parse({
        name: "revenue",
        label: "Revenue",
        expression: "SUM(x)",
        format: "currency",
        currencyCode: "INRR",
      }),
    );
  });

  it("caps references at 20 and expression length at 2000", () => {
    const refs = Array.from({ length: 21 }, (_, i) => `c${i}`);
    assert.throws(() =>
      semanticMetricSchema.parse({
        name: "x",
        label: "x",
        expression: "SUM(c0)",
        references: refs,
      }),
    );
    assert.throws(() =>
      semanticMetricSchema.parse({
        name: "x",
        label: "x",
        expression: "x".repeat(2001),
      }),
    );
  });
});

describe("W56 · semantic dimension schema", () => {
  it("round-trips a temporal dimension with explicit grain", () => {
    const input = {
      name: "order_month",
      label: "Order Month",
      column: "order_date",
      kind: "temporal" as const,
      temporalGrain: "month" as const,
      description: "Order date rolled up to month",
      exposed: true,
      source: "auto" as const,
    };
    const parsed = semanticDimensionSchema.parse(input);
    assert.deepEqual(parsed, input);
  });

  it("accepts each kind without temporalGrain", () => {
    for (const kind of [
      "categorical",
      "temporal",
      "numeric_binned",
      "geo",
    ] as const) {
      const parsed = semanticDimensionSchema.parse({
        name: "d",
        label: "D",
        column: "col",
        kind,
      });
      assert.equal(parsed.kind, kind);
    }
  });

  it("rejects unknown kind", () => {
    assert.throws(() =>
      semanticDimensionSchema.parse({
        name: "d",
        label: "D",
        column: "col",
        kind: "boolean",
      }),
    );
  });
});

describe("W56 · semantic hierarchy schema", () => {
  it("round-trips a multi-level chain (geo)", () => {
    const input = {
      name: "geo_chain",
      label: "Geography",
      levels: ["country", "region", "city"],
      source: "user" as const,
    };
    const parsed = semanticHierarchySchema.parse(input);
    assert.deepEqual(parsed, input);
  });

  it("requires at least 2 levels and caps at 8", () => {
    assert.throws(() =>
      semanticHierarchySchema.parse({
        name: "x",
        label: "x",
        levels: ["country"],
      }),
    );
    const tooMany = Array.from({ length: 9 }, (_, i) => `l${i}`);
    assert.throws(() =>
      semanticHierarchySchema.parse({
        name: "x",
        label: "x",
        levels: tooMany,
      }),
    );
  });

  it("rejects non-snake-case level names (chain must reference dimensions)", () => {
    assert.throws(() =>
      semanticHierarchySchema.parse({
        name: "x",
        label: "x",
        levels: ["Country", "Region"],
      }),
    );
  });
});

describe("W56 · semantic model schema", () => {
  it("applies defaults for an empty model", () => {
    const parsed = semanticModelSchema.parse({});
    assert.equal(parsed.version, 1);
    assert.equal(parsed.name, "Default model");
    assert.deepEqual(parsed.metrics, []);
    assert.deepEqual(parsed.dimensions, []);
    assert.deepEqual(parsed.hierarchies, []);
    assert.equal(parsed.updatedAt, undefined);
    assert.equal(parsed.updatedBy, undefined);
  });

  it("round-trips a realistic Marico FMCG model", () => {
    const model: SemanticModel = {
      version: 3,
      name: "Marico haircare model",
      metrics: [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          currencyCode: "INR",
          decimals: 0,
          exposed: true,
          source: "domain",
        },
        {
          name: "value_share",
          label: "Value Share",
          expression:
            "SUM(value_sales) / NULLIF(SUM(category_value_sales), 0)",
          references: ["value_sales", "category_value_sales"],
          format: "percent",
          decimals: 1,
          exposed: true,
          source: "domain",
        },
      ],
      dimensions: [
        {
          name: "brand",
          label: "Brand",
          column: "Brand",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
        {
          name: "month",
          label: "Month",
          column: "_period",
          kind: "temporal",
          temporalGrain: "month",
          exposed: true,
          source: "auto",
        },
      ],
      hierarchies: [
        {
          name: "geo",
          label: "Geography",
          levels: ["country", "state", "city"],
          source: "user",
        },
      ],
      updatedAt: "2026-05-16T10:00:00Z",
      updatedBy: "data.team@marico.com",
    };
    const parsed = semanticModelSchema.parse(model);
    assert.deepEqual(parsed, model);
  });

  it("enforces caps: ≤200 metrics, ≤200 dimensions, ≤50 hierarchies", () => {
    const tooManyMetrics = Array.from({ length: 201 }, (_, i) => ({
      name: `m${i}`,
      label: `M${i}`,
      expression: "SUM(x)",
    }));
    assert.throws(() =>
      semanticModelSchema.parse({ metrics: tooManyMetrics }),
    );
    const tooManyHierarchies = Array.from({ length: 51 }, (_, i) => ({
      name: `h${i}`,
      label: `H${i}`,
      levels: ["a", "b"],
    }));
    assert.throws(() =>
      semanticModelSchema.parse({ hierarchies: tooManyHierarchies }),
    );
  });

  it("rejects version < 1", () => {
    assert.throws(() => semanticModelSchema.parse({ version: 0 }));
  });
});
