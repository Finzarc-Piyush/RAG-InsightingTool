import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snowflakeTruncationWarning } from "../lib/snowflakeService.js";

describe("Phase 0 · snowflakeTruncationWarning", () => {
  it("returns null when not truncated", () => {
    assert.equal(
      snowflakeTruncationWarning({ truncated: false, limit: 500_000 }),
      null,
    );
  });

  it("warns with 'more rows' when the true total is unknown", () => {
    const w = snowflakeTruncationWarning({ truncated: true, limit: 500_000 });
    assert.ok(w);
    assert.ok(w!.includes("500,000"));
    assert.ok(w!.includes("more rows"));
    assert.ok(w!.includes("SNOWFLAKE_MAX_IMPORT_ROWS"));
  });

  it("includes the known total when provided and larger than the limit", () => {
    const w = snowflakeTruncationWarning({
      truncated: true,
      limit: 500_000,
      knownTotalRows: 1_200_000,
    });
    assert.ok(w!.includes("1,200,000"));
  });

  it("falls back to 'more rows' when knownTotalRows <= limit (defensive)", () => {
    const w = snowflakeTruncationWarning({
      truncated: true,
      limit: 500_000,
      knownTotalRows: 400_000,
    });
    assert.ok(w!.includes("more rows"));
  });
});
