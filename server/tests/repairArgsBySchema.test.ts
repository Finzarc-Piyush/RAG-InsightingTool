/**
 * repairArgsBySchema — deterministic, schema-driven repair of planner tool args.
 * Covers the two production failures that aborted "build a pjp dashboard":
 *   - detect_seasonality with an extra `periodKind` key (strict → unrecognized_keys)
 *   - compute_growth with `aggregation: "count"` (bad optional enum)
 * plus the safety contract: only return args that NOW validate; never mutate input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { repairArgsBySchema } from "../lib/agents/runtime/repairArgsBySchema.js";

// Strict schema with a required field + optional enum carrying a default — mirrors
// compute_growth's shape (aggregation is an optional enum).
const growthSchema = z
  .object({
    metricColumn: z.string(),
    aggregation: z.enum(["sum", "avg", "min", "max"]).default("sum"),
    grain: z.enum(["yoy", "qoq", "mom", "auto"]).optional(),
  })
  .strict();

// Strict schema with NO `periodKind` field — mirrors detect_seasonality.
const seasonalitySchema = z
  .object({
    metricColumn: z.string(),
    dateColumn: z.string(),
    granularity: z.enum(["month", "quarter", "auto"]).optional(),
  })
  .strict();

// Required enum field — deleting it must NOT be considered a valid repair.
const requiredEnumSchema = z
  .object({ mode: z.enum(["series", "summary", "trend"]) })
  .strict();

// Nested strict object inside an array — mirrors dimensionFilters[] items.
const nestedSchema = z
  .object({
    metricColumn: z.string(),
    dimensionFilters: z
      .array(
        z.object({ column: z.string(), op: z.enum(["in", "not_in"]) }).strict()
      )
      .optional(),
  })
  .strict();

describe("repairArgsBySchema", () => {
  it("deletes an unrecognized top-level key (the detect_seasonality `periodKind` case)", () => {
    const out = repairArgsBySchema(seasonalitySchema, {
      metricColumn: "PJP Adherence",
      dateColumn: "Date",
      periodKind: "month",
    });
    assert.ok(out.args, "should repair");
    assert.deepEqual(out.args, { metricColumn: "PJP Adherence", dateColumn: "Date" });
    assert.equal(out.changes.length, 1);
    assert.match(out.changes[0], /periodKind/);
    assert.ok(seasonalitySchema.safeParse(out.args).success);
  });

  it("deletes a bad optional-enum value (the compute_growth `aggregation: \"count\"` case)", () => {
    const out = repairArgsBySchema(growthSchema, {
      metricColumn: "Sales",
      aggregation: "count",
    });
    assert.ok(out.args);
    assert.equal("aggregation" in out.args, false, "bad enum key removed");
    assert.match(out.changes[0], /aggregation/);
  });

  it("lets the schema default apply after deleting the bad enum value", () => {
    const out = repairArgsBySchema(growthSchema, {
      metricColumn: "Sales",
      aggregation: "count",
    });
    assert.ok(out.args);
    const parsed = growthSchema.parse(out.args);
    assert.equal(parsed.aggregation, "sum"); // default reinstated
  });

  it("returns null for a bad value on a REQUIRED field (no unsafe deletion)", () => {
    const out = repairArgsBySchema(requiredEnumSchema, { mode: "trendline" });
    assert.equal(out.args, null);
  });

  it("returns null when a required field is missing", () => {
    const out = repairArgsBySchema(growthSchema, { aggregation: "sum" });
    assert.equal(out.args, null);
  });

  it("repairs multiple issues in one call", () => {
    const out = repairArgsBySchema(growthSchema, {
      metricColumn: "Sales",
      aggregation: "count",
      bogus: true,
      alsoBogus: 1,
    });
    assert.ok(out.args);
    assert.deepEqual(out.args, { metricColumn: "Sales" });
    assert.equal(out.changes.length, 3);
  });

  it("deletes an unrecognized key inside a nested strict array element", () => {
    const out = repairArgsBySchema(nestedSchema, {
      metricColumn: "Sales",
      dimensionFilters: [{ column: "Cluster", op: "in", weird: 1 }],
    });
    assert.ok(out.args);
    assert.deepEqual(out.args, {
      metricColumn: "Sales",
      dimensionFilters: [{ column: "Cluster", op: "in" }],
    });
    assert.match(out.changes[0], /weird/);
  });

  it("is a no-op for already-valid args", () => {
    const input = { metricColumn: "Sales", aggregation: "avg" as const };
    const out = repairArgsBySchema(growthSchema, input);
    assert.deepEqual(out.args, input);
    assert.equal(out.changes.length, 0);
  });

  it("returns null for an error that deletion cannot fix", () => {
    const out = repairArgsBySchema(growthSchema, { metricColumn: 42 });
    assert.equal(out.args, null);
  });

  it("never mutates the caller's input object", () => {
    const input = { metricColumn: "Sales", aggregation: "count", bogus: true };
    const snapshot = JSON.parse(JSON.stringify(input));
    repairArgsBySchema(growthSchema, input);
    assert.deepEqual(input, snapshot);
  });

  it("terminates (no infinite loop) on a non-deletable error", () => {
    // Required missing → invalid_type → not deletable → early break → null.
    const out = repairArgsBySchema(requiredEnumSchema, {});
    assert.equal(out.args, null);
  });
});
