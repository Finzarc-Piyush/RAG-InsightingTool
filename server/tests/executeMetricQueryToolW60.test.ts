import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compiledPlanToQueryPlanBody,
  executeMetricQueryArgsSchema,
} from "../lib/agents/runtime/tools/executeMetricQueryTool.js";
import type { CompiledQueryPlan } from "../lib/semantic/compiler.js";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const registerToolsSrc = readFileSync(
  repoFile("../lib/agents/runtime/tools/registerTools.ts"),
  "utf-8",
);
const plannerSrc = readFileSync(
  repoFile("../lib/agents/runtime/planner.ts"),
  "utf-8",
);
const toolSrc = readFileSync(
  repoFile("../lib/agents/runtime/tools/executeMetricQueryTool.ts"),
  "utf-8",
);

describe("W60 · executeMetricQueryArgsSchema — valid shapes", () => {
  it("parses the minimal shape (metric only)", () => {
    const r = executeMetricQueryArgsSchema.safeParse({ metric: "net_sales" });
    assert.equal(r.success, true);
  });

  it("parses a full shape with breakdownBy + filters + sortBy + limit", () => {
    const r = executeMetricQueryArgsSchema.safeParse({
      metric: "net_sales",
      breakdownBy: ["region", "channel"],
      filters: [
        { dimension: "region", op: "in", values: ["North", "South"] },
        {
          dimension: "price",
          op: "between",
          values: ["10", "100"],
          match: "exact",
        },
      ],
      sortBy: { by: "net_sales", direction: "desc" },
      limit: 50,
    });
    assert.equal(r.success, true);
  });

  it("accepts every filter op the compiler emits", () => {
    for (const op of [
      "in",
      "not_in",
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "between",
    ] as const) {
      const r = executeMetricQueryArgsSchema.safeParse({
        metric: "x",
        filters: [{ dimension: "y", op, values: ["1"] }],
      });
      assert.equal(r.success, true, `op ${op} should parse`);
    }
  });
});

describe("W60 · executeMetricQueryArgsSchema — rejections", () => {
  it("rejects empty metric", () => {
    const r = executeMetricQueryArgsSchema.safeParse({ metric: "" });
    assert.equal(r.success, false);
  });

  it("rejects extra top-level keys (strict)", () => {
    const r = executeMetricQueryArgsSchema.safeParse({
      metric: "net_sales",
      extraKey: "boom",
    } as Record<string, unknown>);
    assert.equal(r.success, false);
  });

  it("rejects extra keys inside a filter (strict)", () => {
    const r = executeMetricQueryArgsSchema.safeParse({
      metric: "x",
      filters: [
        {
          dimension: "y",
          op: "in",
          values: ["1"],
          unknownField: true,
        } as Record<string, unknown>,
      ],
    });
    assert.equal(r.success, false);
  });

  it("rejects an unknown filter op", () => {
    const r = executeMetricQueryArgsSchema.safeParse({
      metric: "x",
      filters: [{ dimension: "y", op: "regex" as never, values: ["a"] }],
    });
    assert.equal(r.success, false);
  });

  it("rejects empty filter values array", () => {
    const r = executeMetricQueryArgsSchema.safeParse({
      metric: "x",
      filters: [{ dimension: "y", op: "in", values: [] }],
    });
    assert.equal(r.success, false);
  });

  it("rejects breakdownBy with more than 8 entries", () => {
    const r = executeMetricQueryArgsSchema.safeParse({
      metric: "x",
      breakdownBy: Array.from({ length: 9 }, (_, i) => `d${i}`),
    });
    assert.equal(r.success, false);
  });

  it("rejects sortBy with extra keys (strict)", () => {
    const r = executeMetricQueryArgsSchema.safeParse({
      metric: "x",
      sortBy: { by: "x", direction: "desc", tiebreak: "alpha" } as Record<
        string,
        unknown
      >,
    });
    assert.equal(r.success, false);
  });
});

describe("W60 · compiledPlanToQueryPlanBody — shape roundtrip", () => {
  const baseAggregation = {
    column: "value_sales",
    operation: "sum" as const,
    alias: "net_sales",
  };

  it("emits aggregations array verbatim (column/operation/alias)", () => {
    const compiled: CompiledQueryPlan = { aggregations: [baseAggregation] };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.deepEqual(body.aggregations, [baseAggregation]);
  });

  it("includes groupBy when non-empty", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [baseAggregation],
      groupBy: ["region", "channel"],
    };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.deepEqual(body.groupBy, ["region", "channel"]);
  });

  it("omits groupBy when the compiler emitted []", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [baseAggregation],
      groupBy: [],
    };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.equal(body.groupBy, undefined);
  });

  it("forwards computedAggregations", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [
        { column: "value_sales", operation: "sum", alias: "_sum_value_sales" },
        { column: "returns", operation: "sum", alias: "_sum_returns" },
      ],
      computedAggregations: [
        {
          alias: "net_sales",
          expression: "_sum_value_sales - _sum_returns",
        },
      ],
    };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.deepEqual(body.computedAggregations, [
      { alias: "net_sales", expression: "_sum_value_sales - _sum_returns" },
    ]);
  });

  it("forwards dimensionFilters with `match` when present", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [baseAggregation],
      dimensionFilters: [
        {
          column: "region",
          op: "in",
          values: ["North"],
          match: "case_insensitive",
        },
      ],
    };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.deepEqual(body.dimensionFilters, [
      {
        column: "region",
        op: "in",
        values: ["North"],
        match: "case_insensitive",
      },
    ]);
  });

  it("omits `match` on filters when absent", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [baseAggregation],
      dimensionFilters: [
        { column: "region", op: "in", values: ["North"] },
      ],
    };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.deepEqual(body.dimensionFilters, [
      { column: "region", op: "in", values: ["North"] },
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        body.dimensionFilters![0],
        "match",
      ),
      false,
    );
  });

  it("forwards sort", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [baseAggregation],
      sort: [{ column: "net_sales", direction: "desc" }],
    };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.deepEqual(body.sort, [{ column: "net_sales", direction: "desc" }]);
  });

  it("forwards limit", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [baseAggregation],
      limit: 25,
    };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.equal(body.limit, 25);
  });

  it("omits limit when undefined", () => {
    const compiled: CompiledQueryPlan = { aggregations: [baseAggregation] };
    const body = compiledPlanToQueryPlanBody(compiled);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "limit"),
      false,
    );
  });
});

describe("W60 · compiledPlanToQueryPlanBody — mutation safety", () => {
  it("does not share aggregation array references with the input", () => {
    const compiled: CompiledQueryPlan = {
      aggregations: [
        { column: "value_sales", operation: "sum", alias: "net_sales" },
      ],
      groupBy: ["region"],
      dimensionFilters: [
        { column: "region", op: "in", values: ["North"] },
      ],
    };
    const body = compiledPlanToQueryPlanBody(compiled);

    assert.notStrictEqual(body.aggregations, compiled.aggregations);
    assert.notStrictEqual(body.groupBy, compiled.groupBy);
    assert.notStrictEqual(body.dimensionFilters, compiled.dimensionFilters);
    assert.notStrictEqual(
      body.dimensionFilters![0].values,
      compiled.dimensionFilters![0].values,
    );

    body.groupBy!.push("bleed");
    assert.deepEqual(compiled.groupBy, ["region"]);
  });
});

describe("W60 · registerTools.ts wiring", () => {
  it("imports registerExecuteMetricQueryTool from ./executeMetricQueryTool.js", () => {
    assert.match(
      registerToolsSrc,
      /import \{ registerExecuteMetricQueryTool \} from "\.\/executeMetricQueryTool\.js"/,
    );
  });

  it("invokes registerExecuteMetricQueryTool(registry) inside registerTools", () => {
    assert.match(
      registerToolsSrc,
      /registerExecuteMetricQueryTool\(registry\)/,
    );
  });
});

describe("W60 · executeMetricQueryTool.ts — tool registration shape", () => {
  it("registers the tool under the literal name 'execute_metric_query'", () => {
    assert.match(toolSrc, /registry\.register\(\s*"execute_metric_query"/);
  });

  it("dispatches through registry.execute(\"execute_query_plan\", { plan }, ctx)", () => {
    assert.match(
      toolSrc,
      /registry\.execute\(\s*"execute_query_plan",\s*\{\s*plan\s*\},\s*ctx,?\s*\)/,
    );
  });

  it("guards on ctx.exec.mode !== \"analysis\"", () => {
    assert.match(toolSrc, /ctx\.exec\.mode !== "analysis"/);
  });

  it("reads the semantic model from ctx.exec.chatDocument?.semanticModel", () => {
    assert.match(
      toolSrc,
      /ctx\.exec\.chatDocument\?\.semanticModel/,
    );
  });
});

describe("W60 · planner.ts SEMANTIC_CATALOG rule wiring", () => {
  it("emits a planner rule that references SEMANTIC_CATALOG + execute_metric_query", () => {
    assert.match(plannerSrc, /SEMANTIC_CATALOG \(when present in the user message\)/);
    assert.match(plannerSrc, /execute_metric_query/);
  });

  it("instructs the planner to PREFER execute_metric_query over execute_query_plan", () => {
    assert.match(
      plannerSrc,
      /PREFER\s+\S*execute_metric_query\S*\s+over\s+\S*execute_query_plan/,
    );
  });
});
