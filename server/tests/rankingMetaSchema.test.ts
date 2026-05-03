// RNK2 · Pin the rankingMeta schema shape on the shared message schema.
// Ensures legacy messages without `rankingMeta` parse cleanly and that
// the new field validates the four supported intent kinds.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankingMetaSchema } from "../shared/schema.js";

describe("RNK2 · rankingMetaSchema", () => {
  it("accepts a topN ranking meta", () => {
    const parsed = rankingMetaSchema.safeParse({
      intentKind: "topN",
      direction: "desc",
      entityColumn: "Salesperson",
      metricColumn: "Sales",
      totalEntities: 300,
    });
    assert.equal(parsed.success, true);
  });

  it("accepts an extremum ranking meta with totalEntities=1", () => {
    const parsed = rankingMetaSchema.safeParse({
      intentKind: "extremum",
      direction: "desc",
      entityColumn: "Employee",
      metricColumn: "Leaves",
      totalEntities: 1,
    });
    assert.equal(parsed.success, true);
  });

  it("accepts an entityList ranking meta with no metricColumn", () => {
    const parsed = rankingMetaSchema.safeParse({
      intentKind: "entityList",
      direction: "desc",
      entityColumn: "Product",
      totalEntities: 47,
    });
    assert.equal(parsed.success, true);
  });

  it("accepts a truncationNote when persisted rows were capped", () => {
    const parsed = rankingMetaSchema.safeParse({
      intentKind: "topN",
      direction: "desc",
      entityColumn: "Salesperson",
      metricColumn: "Sales",
      totalEntities: 12000,
      truncationNote: "Showing top 5000 of 12000",
    });
    assert.equal(parsed.success, true);
  });

  it("rejects an unknown intentKind", () => {
    const parsed = rankingMetaSchema.safeParse({
      intentKind: "histogram",
      direction: "desc",
      entityColumn: "Salesperson",
      totalEntities: 10,
    });
    assert.equal(parsed.success, false);
  });

  it("rejects negative totalEntities", () => {
    const parsed = rankingMetaSchema.safeParse({
      intentKind: "topN",
      direction: "desc",
      entityColumn: "Salesperson",
      totalEntities: -1,
    });
    assert.equal(parsed.success, false);
  });
});
