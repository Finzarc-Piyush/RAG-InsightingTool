import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferModel,
  toSnakeCase,
} from "../lib/semantic/inferModel.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(
  cols: Array<Partial<DataSummary["columns"][number]> & { name: string; type: string }>,
  extras: Partial<DataSummary> = {},
): DataSummary {
  return {
    rowCount: extras.rowCount ?? 1000,
    columnCount: cols.length,
    columns: cols.map((c) => ({
      name: c.name,
      type: c.type,
      sampleValues: c.sampleValues ?? [],
      topValues: c.topValues,
      temporalDisplayGrain: c.temporalDisplayGrain,
      temporalFacetGrain: c.temporalFacetGrain,
      temporalFacetSource: c.temporalFacetSource,
      dateRange: c.dateRange,
      currency: c.currency,
      timeOfDay: c.timeOfDay,
      indicator: c.indicator,
      answersQuestions: c.answersQuestions,
    })),
    numericColumns: extras.numericColumns ?? cols
      .filter((c) =>
        ["number", "numeric", "integer", "float", "double"].includes(c.type.toLowerCase()),
      )
      .map((c) => c.name),
    dateColumns: extras.dateColumns ?? cols
      .filter((c) => ["date", "datetime"].includes(c.type.toLowerCase()))
      .map((c) => c.name),
    temporalFacetColumns: extras.temporalFacetColumns,
    wideFormatTransform: extras.wideFormatTransform,
    dateTimeColumnPairs: extras.dateTimeColumnPairs,
  };
}

describe("W57 · toSnakeCase", () => {
  it("converts free-form column names to snake_case", () => {
    assert.equal(toSnakeCase("Total Sales"), "total_sales");
    assert.equal(toSnakeCase("Sales (USD)"), "sales_usd");
    assert.equal(toSnakeCase("Region/City"), "region_city");
    assert.equal(toSnakeCase("camelCaseField"), "camel_case_field");
    assert.equal(toSnakeCase("ALLCAPS"), "allcaps");
  });

  it("strips leading and trailing underscores", () => {
    assert.equal(toSnakeCase("_period"), "period");
    assert.equal(toSnakeCase("__tf_year"), "tf_year");
    assert.equal(toSnakeCase("trailing_"), "trailing");
  });

  it("guards against leading digit (schema requires [a-z] first char)", () => {
    assert.equal(toSnakeCase("123_metric"), "field_123_metric");
    assert.equal(toSnakeCase("2024_year"), "field_2024_year");
  });

  it("falls back to 'field' on empty / pure-punctuation input", () => {
    assert.equal(toSnakeCase(""), "field");
    assert.equal(toSnakeCase("___"), "field");
    assert.equal(toSnakeCase("()"), "field");
  });
});

describe("W57 · inferModel — long-form datasets", () => {
  it("emits SUM(<col>) metric for each numeric column + a row_count metric", () => {
    const summary = makeSummary([
      { name: "Sales", type: "number" },
      { name: "Units", type: "integer" },
      { name: "Brand", type: "string", topValues: [{ value: "Marico", count: 30 }] },
    ]);
    const model = inferModel({ summary });
    const metricNames = model.metrics.map((m) => m.name);
    assert.deepEqual(metricNames.sort(), ["row_count", "sales", "units"].sort());

    const sales = model.metrics.find((m) => m.name === "sales")!;
    assert.equal(sales.expression, "SUM(Sales)");
    assert.deepEqual(sales.references, ["Sales"]);
    assert.equal(sales.format, "number");
    assert.equal(sales.source, "auto");

    const rowCount = model.metrics.find((m) => m.name === "row_count")!;
    assert.equal(rowCount.expression, "COUNT(*)");
    assert.equal(rowCount.decimals, 0);
  });

  it("tags currency-decorated numeric columns with format=currency + currencyCode", () => {
    const summary = makeSummary([
      {
        name: "Revenue",
        type: "number",
        currency: { isoCode: "INR", symbol: "₹", confidence: 1 },
      },
    ]);
    const model = inferModel({ summary });
    const revenue = model.metrics.find((m) => m.name === "revenue")!;
    assert.equal(revenue.format, "currency");
    assert.equal(revenue.currencyCode, "INR");
  });

  it("emits one categorical dimension per low-cardinality string column", () => {
    const summary = makeSummary([
      { name: "Brand", type: "string", topValues: [{ value: "Marico", count: 10 }] },
      { name: "Region", type: "string", topValues: [{ value: "North", count: 5 }] },
      // High-cardinality string with no topValues — should NOT become a dimension.
      { name: "TransactionId", type: "string" },
    ]);
    const model = inferModel({ summary });
    const dimNames = model.dimensions.map((d) => d.name);
    assert.ok(dimNames.includes("brand"));
    assert.ok(dimNames.includes("region"));
    assert.ok(!dimNames.includes("transaction_id"), "TransactionId is high-cardinality, not a dimension");
    for (const d of model.dimensions) {
      assert.equal(d.kind, "categorical");
      assert.equal(d.source, "auto");
    }
  });

  it("emits a temporal dimension per date column with grain mapped from temporalDisplayGrain", () => {
    const summary = makeSummary([
      { name: "OrderDate", type: "date", temporalDisplayGrain: "year" },
      { name: "ShipDate", type: "date", temporalDisplayGrain: "monthOrQuarter" },
      { name: "DeliveryDate", type: "date" }, // no grain hint
    ]);
    const model = inferModel({ summary });
    const orderDate = model.dimensions.find((d) => d.name === "order_date")!;
    assert.equal(orderDate.kind, "temporal");
    assert.equal(orderDate.temporalGrain, "year");
    const shipDate = model.dimensions.find((d) => d.name === "ship_date")!;
    assert.equal(shipDate.temporalGrain, "month");
    const deliveryDate = model.dimensions.find((d) => d.name === "delivery_date")!;
    assert.equal(deliveryDate.temporalGrain, undefined);
  });

  it("excludes hidden __tf_* facet columns from both metrics and dimensions", () => {
    const summary = makeSummary([
      { name: "Sales", type: "number" },
      { name: "__tf_year", type: "number" },
      { name: "__tf_month", type: "number" },
    ]);
    const model = inferModel({ summary });
    for (const m of model.metrics) {
      assert.ok(!m.name.startsWith("tf_") && !m.references.some((r) => r.startsWith("__tf_")));
    }
    for (const d of model.dimensions) {
      assert.ok(!d.column.startsWith("__tf_"));
    }
  });

  it("treats indicator columns as categorical dimensions, not metrics", () => {
    const summary = makeSummary([
      { name: "OnTime", type: "string", indicator: { kind: "boolean", source: "auto" } },
      { name: "Status", type: "string", indicator: { kind: "categorical", source: "llm" } },
      { name: "Sales", type: "number" },
    ]);
    const model = inferModel({ summary });
    const dimNames = model.dimensions.map((d) => d.name);
    assert.ok(dimNames.includes("on_time"));
    assert.ok(dimNames.includes("status"));
    // Indicator columns are NEVER metrics
    for (const m of model.metrics) {
      assert.ok(!["on_time", "status"].includes(m.name));
    }
  });

  it("disambiguates snake-case collisions with numeric suffix", () => {
    const summary = makeSummary([
      { name: "Sales (USD)", type: "number" },
      { name: "Sales (EUR)", type: "number" },
      { name: "Sales (INR)", type: "number" },
    ]);
    const model = inferModel({ summary });
    const names = model.metrics
      .filter((m) => m.name !== "row_count")
      .map((m) => m.name)
      .sort();
    // First wins the bare name; subsequent collide and append _2 / _3
    assert.deepEqual(names, ["sales_eur", "sales_inr", "sales_usd"]);
  });

  it("produces a parseable model that round-trips through the zod schema", async () => {
    const { semanticModelSchema } = await import("../shared/schema.js");
    const summary = makeSummary([
      { name: "Revenue", type: "number", currency: { isoCode: "USD", symbol: "$", confidence: 1 } },
      { name: "Region", type: "string", topValues: [{ value: "EMEA", count: 10 }] },
      { name: "OrderDate", type: "date", temporalDisplayGrain: "year" },
    ]);
    const model = inferModel({ summary });
    const parsed = semanticModelSchema.parse(model);
    assert.equal(parsed.metrics.length, model.metrics.length);
    assert.equal(parsed.dimensions.length, model.dimensions.length);
  });

  it("defaults to version=1, model name from input or fallback", () => {
    const summary = makeSummary([{ name: "X", type: "number" }]);
    const a = inferModel({ summary });
    assert.equal(a.version, 1);
    assert.equal(a.name, "Default model");

    const b = inferModel({ summary, modelName: "Marico haircare model" });
    assert.equal(b.name, "Marico haircare model");
  });

  it("empty dataset summary yields just row_count + no dimensions", () => {
    const summary = makeSummary([]);
    const model = inferModel({ summary });
    assert.equal(model.metrics.length, 1);
    assert.equal(model.metrics[0].name, "row_count");
    assert.equal(model.dimensions.length, 0);
    assert.equal(model.hierarchies.length, 0);
  });
});

describe("W57 · inferModel — wide-format datasets", () => {
  it("emits generic value metric + _metric dimension + _period temporal dimension", () => {
    const summary = makeSummary(
      [
        { name: "Brand", type: "string", topValues: [{ value: "Parachute", count: 50 }] },
        { name: "Region", type: "string", topValues: [{ value: "North", count: 20 }] },
        { name: "_metric", type: "string", topValues: [{ value: "Value Sales", count: 100 }] },
        { name: "_period", type: "string", topValues: [{ value: "2024-Q1", count: 50 }] },
        { name: "value", type: "number" },
      ],
      {
        wideFormatTransform: {
          appliedAt: "2026-05-16T00:00:00Z",
          idVars: ["Brand", "Region"],
          valueVars: ["Value Sales", "Volume Sales"],
        } as DataSummary["wideFormatTransform"],
      },
    );
    const model = inferModel({ summary });

    const valueMetric = model.metrics.find((m) => m.name === "value");
    assert.ok(valueMetric, "expected a 'value' metric");
    assert.equal(valueMetric!.expression, "SUM(value)");

    const metricDim = model.dimensions.find((d) => d.column === "_metric");
    assert.ok(metricDim, "expected an _metric dimension");
    assert.equal(metricDim!.kind, "categorical");

    const periodDim = model.dimensions.find((d) => d.column === "_period");
    assert.ok(periodDim, "expected a _period dimension");
    assert.equal(periodDim!.kind, "temporal");

    // value is NOT a dimension (it's the metric)
    assert.ok(!model.dimensions.some((d) => d.column === "value"));

    // Id-vars (Brand, Region) become categorical dimensions
    assert.ok(model.dimensions.some((d) => d.column === "Brand"));
    assert.ok(model.dimensions.some((d) => d.column === "Region"));
  });
});
