import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileMetricQuery,
  type SemanticFilter,
} from "../lib/semantic/compiler.js";
import type { SemanticModel } from "../shared/schema.js";

function modelWith(
  metrics: SemanticModel["metrics"],
  dimensions: SemanticModel["dimensions"] = [],
): SemanticModel {
  return {
    version: 1,
    name: "test",
    metrics,
    dimensions,
    hierarchies: [],
  };
}

describe("W58 · compileMetricQuery — simple single-aggregation metrics", () => {
  it("compiles SUM(col) directly under the metric's name", () => {
    const model = modelWith([
      {
        name: "value_sales",
        label: "Value Sales",
        expression: "SUM(value_sales)",
        references: ["value_sales"],
        format: "currency",
        currencyCode: "INR",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "value_sales" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.aggregations, [
      { column: "value_sales", operation: "sum", alias: "value_sales" },
    ]);
    assert.equal(result.plan.computedAggregations, undefined);
  });

  it("compiles AVG(col) → operation:mean", () => {
    const model = modelWith([
      {
        name: "avg_price",
        label: "Avg Price",
        expression: "AVG(price)",
        references: ["price"],
        format: "currency",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "avg_price" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.aggregations[0].operation, "mean");
  });

  it("compiles COUNT(*) without column", () => {
    const model = modelWith([
      {
        name: "row_count",
        label: "Row Count",
        expression: "COUNT(*)",
        references: [],
        format: "number",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "row_count" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.aggregations[0].operation, "count");
    assert.equal(result.plan.aggregations[0].column, "*");
  });

  it("compiles COUNT(DISTINCT col) → operation:count_distinct", () => {
    const model = modelWith([
      {
        name: "unique_brands",
        label: "Unique Brands",
        expression: "COUNT(DISTINCT brand)",
        references: ["brand"],
        format: "number",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "unique_brands" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.aggregations[0].operation, "count_distinct");
    assert.equal(result.plan.aggregations[0].column, "brand");
  });

  it("handles every aggregation operator (MIN/MAX/MEDIAN/MEAN)", () => {
    const checks: Array<[string, string]> = [
      ["MIN(x)", "min"],
      ["MAX(x)", "max"],
      ["MEDIAN(x)", "median"],
      ["MEAN(x)", "mean"],
    ];
    for (const [expr, op] of checks) {
      const model = modelWith([
        {
          name: "m",
          label: "M",
          expression: expr,
          references: ["x"],
          format: "number",
          exposed: true,
          source: "auto",
        },
      ]);
      const result = compileMetricQuery({ model, metric: "m" });
      assert.equal(result.ok, true, `expected ok for ${expr}`);
      if (!result.ok) continue;
      assert.equal(result.plan.aggregations[0].operation, op, `expected ${op} for ${expr}`);
    }
  });
});

describe("W58 · compileMetricQuery — composite arithmetic metrics", () => {
  it("compiles SUM(a) - SUM(b) into 2 aggregations + 1 computedAggregation", () => {
    const model = modelWith([
      {
        name: "net_sales",
        label: "Net Sales",
        expression: "SUM(gross_sales) - SUM(returns)",
        references: ["gross_sales", "returns"],
        format: "currency",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "net_sales" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.aggregations.length, 2);
    const aliases = result.plan.aggregations.map((a) => a.alias).sort();
    assert.deepEqual(aliases, ["_sum_gross_sales", "_sum_returns"]);
    assert.equal(result.plan.computedAggregations?.length, 1);
    assert.equal(result.plan.computedAggregations?.[0].alias, "net_sales");
    assert.equal(
      result.plan.computedAggregations?.[0].expression,
      "_sum_gross_sales - _sum_returns",
    );
  });

  it("compiles SUM(a) / SUM(b) → ratio metric (ASP)", () => {
    const model = modelWith([
      {
        name: "asp",
        label: "ASP",
        expression: "SUM(value_sales) / SUM(units)",
        references: ["value_sales", "units"],
        format: "currency",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "asp" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.aggregations.length, 2);
    assert.equal(
      result.plan.computedAggregations?.[0].expression,
      "_sum_value_sales / _sum_units",
    );
  });

  it("dedupes repeated aggregations: SUM(x) + SUM(x) → 1 aggregation, computed substitutes both", () => {
    const model = modelWith([
      {
        name: "double_x",
        label: "Double X",
        expression: "SUM(x) + SUM(x)",
        references: ["x"],
        format: "number",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "double_x" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.aggregations.length, 1);
    assert.equal(
      result.plan.computedAggregations?.[0].expression,
      "_sum_x + _sum_x",
    );
  });

  it("rejects expressions with NULLIF / CASE / commas (post-W58 widening)", () => {
    const model = modelWith([
      {
        name: "value_share",
        label: "Value Share",
        expression: "SUM(value_sales) / NULLIF(SUM(category_value_sales), 0)",
        references: ["value_sales", "category_value_sales"],
        format: "percent",
        exposed: true,
        source: "auto",
      },
    ]);
    const result = compileMetricQuery({ model, metric: "value_share" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not allowed in computedAggregations/);
  });
});

describe("W58 · compileMetricQuery — breakdownBy + filters", () => {
  it("resolves breakdown dimension names to underlying columns", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [
        {
          name: "brand",
          label: "Brand",
          column: "Brand",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
        {
          name: "region",
          label: "Region",
          column: "Region",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
      ],
    );
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      breakdownBy: ["brand", "region"],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.groupBy, ["Brand", "Region"]);
  });

  it("compiles a categorical 'in' filter to dimensionFilter", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [
        {
          name: "brand",
          label: "Brand",
          column: "Brand",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
      ],
    );
    const filter: SemanticFilter = {
      dimension: "brand",
      op: "in",
      values: ["Parachute", "Saffola"],
    };
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      filters: [filter],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.dimensionFilters, [
      { column: "Brand", op: "in", values: ["Parachute", "Saffola"] },
    ]);
  });

  it("forwards the `match` modifier through to the dimensionFilter", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [
        {
          name: "brand",
          label: "Brand",
          column: "Brand",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
      ],
    );
    const filter: SemanticFilter = {
      dimension: "brand",
      op: "in",
      values: ["parachute"],
      match: "case_insensitive",
    };
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      filters: [filter],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.dimensionFilters?.[0].match, "case_insensitive");
  });

  it("returns error when breakdown dimension is unknown", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [
        {
          name: "brand",
          label: "Brand",
          column: "Brand",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
      ],
    );
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      breakdownBy: ["does_not_exist"],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Unknown breakdown dimension/);
  });
});

describe("W58 · compileMetricQuery — sort + limit", () => {
  it("sorts by the metric alias", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [
        {
          name: "brand",
          label: "Brand",
          column: "Brand",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
      ],
    );
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      breakdownBy: ["brand"],
      sortBy: { by: "value_sales", direction: "desc" },
      limit: 10,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.sort, [
      { column: "value_sales", direction: "desc" },
    ]);
    assert.equal(result.plan.limit, 10);
  });

  it("sorts by a breakdown dimension column", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [
        {
          name: "brand",
          label: "Brand",
          column: "Brand",
          kind: "categorical",
          exposed: true,
          source: "auto",
        },
      ],
    );
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      breakdownBy: ["brand"],
      sortBy: { by: "brand", direction: "asc" },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.sort?.[0].column, "Brand");
    assert.equal(result.plan.sort?.[0].direction, "asc");
  });
});

describe("W58 · compileMetricQuery — errors", () => {
  it("returns error for unknown metric", () => {
    const model = modelWith([]);
    const result = compileMetricQuery({ model, metric: "nope" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Unknown metric/);
  });

  it("returns error for unknown filter dimension", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [],
    );
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      filters: [{ dimension: "brand", op: "in", values: ["x"] }],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Unknown filter dimension/);
  });

  it("returns error for unknown sort target", () => {
    const model = modelWith(
      [
        {
          name: "value_sales",
          label: "Value Sales",
          expression: "SUM(value_sales)",
          references: ["value_sales"],
          format: "currency",
          exposed: true,
          source: "auto",
        },
      ],
      [],
    );
    const result = compileMetricQuery({
      model,
      metric: "value_sales",
      sortBy: { by: "nowhere", direction: "asc" },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Unknown sort target/);
  });
});
