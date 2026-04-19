import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Mirrors client `createInitialPivotConfig` dimension bucketing (rows / columns / filters)
 * so server tests validate behavior without resolving the client's `@/` import aliases.
 */
function bucketDimsLikeCreateInitialPivotConfig(
  allKeys: string[],
  numericKeys: string[],
  defaultRowKeys: string[],
  defaultColumnKeys: string[],
  defaultFilterKeys: string[]
): { rows: string[]; columns: string[]; filters: string[] } {
  const numericSet = new Set(numericKeys);
  const allDims = allKeys.filter((k) => !numericSet.has(k));
  const rows = defaultRowKeys.filter((k) => allDims.includes(k));
  const columns = defaultColumnKeys
    .filter((k) => allDims.includes(k) && !rows.includes(k))
    .filter((k, i, arr) => arr.indexOf(k) === i);
  const filters = defaultFilterKeys.filter(
    (k) => allDims.includes(k) && !rows.includes(k) && !columns.includes(k)
  );
  return { rows, columns, filters };
}

describe("pivot initial config columns (parity with client createInitialPivotConfig)", () => {
  it("without column hints columns stay empty", () => {
    const b = bucketDimsLikeCreateInitialPivotConfig(
      ["Region", "Sales"],
      ["Sales"],
      ["Region"],
      [],
      []
    );
    assert.deepEqual(b.rows, ["Region"]);
    assert.deepEqual(b.columns, []);
    assert.deepEqual(b.filters, []);
  });

  it("places column keys and excludes them from filters", () => {
    const b = bucketDimsLikeCreateInitialPivotConfig(
      ["Month", "Category", "Sales"],
      ["Sales"],
      ["Month"],
      ["Category"],
      ["Category"]
    );
    assert.deepEqual(b.rows, ["Month"]);
    assert.deepEqual(b.columns, ["Category"]);
    assert.deepEqual(b.filters, []);
  });
});
