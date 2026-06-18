import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chartSpecSchema, barSortSpecSchema } from "../shared/schema.js";

describe("chartSpecSchema · sort field (Wave S2)", () => {
  const base = { type: "bar" as const, title: "t", x: "age", y: "survived" };

  it("accepts a spec carrying an explicit sort", () => {
    const parsed = chartSpecSchema.parse({
      ...base,
      sort: { by: "category", direction: "asc" },
    });
    assert.deepEqual(parsed.sort, { by: "category", direction: "asc" });
  });

  it("accepts a spec WITHOUT sort (field is optional)", () => {
    const parsed = chartSpecSchema.parse(base);
    assert.equal(parsed.sort, undefined);
  });

  it("still accepts a legacy sortDirection-only spec (back-compat)", () => {
    const parsed = chartSpecSchema.parse({ ...base, sortDirection: "asc" });
    assert.equal(parsed.sortDirection, "asc");
    assert.equal(parsed.sort, undefined);
  });

  it("rejects an invalid sort.by value", () => {
    assert.throws(() =>
      barSortSpecSchema.parse({ by: "alphabetical", direction: "asc" }),
    );
  });
});
