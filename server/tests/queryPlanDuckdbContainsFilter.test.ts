import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueryPlanDuckdbSql,
  canExecuteQueryPlanOnDuckDb,
} from "../lib/queryPlanDuckdbExecutor.js";

describe("queryPlanDuckdbExecutor — contains filter (W5)", () => {
  it("canExecuteQueryPlanOnDuckDb now accepts contains filters", () => {
    assert.equal(
      canExecuteQueryPlanOnDuckDb({
        groupBy: ["__tf_month__Order_Date"],
        aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
        dimensionFilters: [
          { column: "Category", op: "in", values: ["furniture"], match: "contains" },
        ],
      }),
      true,
      "DuckDB path must accept contains filters after W5"
    );
  });

  it("buildQueryPlanDuckdbSql emits LIKE %v% on lowered column for contains", () => {
    const built = buildQueryPlanDuckdbSql({
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      dimensionFilters: [
        { column: "Category", op: "in", values: ["furniture"], match: "contains" },
      ],
    });
    assert.ok(built, "plan must compile");
    assert.match(
      built!.aggregateSql,
      /LOWER\(TRIM\(CAST\("Category" AS VARCHAR\)\)\) LIKE '%furniture%' ESCAPE '\\'/,
      "expected LIKE predicate on lowered Category"
    );
    assert.doesNotMatch(
      built!.aggregateSql,
      /WHERE 1=1(?!.*LIKE)/,
      "filter must not be silently dropped"
    );
  });

  it("ORs multiple contains values together", () => {
    const built = buildQueryPlanDuckdbSql({
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      dimensionFilters: [
        {
          column: "Category",
          op: "in",
          values: ["furn", "tech"],
          match: "contains",
        },
      ],
    });
    assert.ok(built);
    assert.match(built!.aggregateSql, /LIKE '%furn%'/);
    assert.match(built!.aggregateSql, /LIKE '%tech%'/);
    assert.match(built!.aggregateSql, /\bOR\b/);
  });

  it("inverts contains filter with op='not_in'", () => {
    const built = buildQueryPlanDuckdbSql({
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      dimensionFilters: [
        {
          column: "Category",
          op: "not_in",
          values: ["furn"],
          match: "contains",
        },
      ],
    });
    assert.ok(built);
    assert.match(built!.aggregateSql, /NOT .*LIKE '%furn%'/);
  });

  it("escapes wildcard metacharacters in the user-supplied value", () => {
    const built = buildQueryPlanDuckdbSql({
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      dimensionFilters: [
        { column: "Notes", op: "in", values: ["50%_off"], match: "contains" },
      ],
    });
    assert.ok(built);
    assert.match(built!.aggregateSql, /LIKE '%50\\%\\_off%'/);
  });

  it("still builds case_insensitive filters as IN lists (unchanged)", () => {
    const built = buildQueryPlanDuckdbSql({
      groupBy: ["Region"],
      aggregations: [{ column: "Sales", operation: "sum", alias: "Sales_sum" }],
      dimensionFilters: [
        {
          column: "Category",
          op: "in",
          values: ["Furniture"],
          match: "case_insensitive",
        },
      ],
    });
    assert.ok(built);
    assert.match(built!.aggregateSql, /IN \('furniture'\)/);
    assert.doesNotMatch(built!.aggregateSql, /LIKE/);
  });
});
