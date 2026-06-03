import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { envPositiveInt, uploadLimits } from "../config/uploadLimits.js";

describe("Phase 0 · uploadLimits config", () => {
  it("envPositiveInt returns fallback when unset / blank / invalid / non-positive", () => {
    delete process.env.__TEST_LIMIT__;
    assert.equal(envPositiveInt("__TEST_LIMIT__", 42), 42);
    process.env.__TEST_LIMIT__ = "";
    assert.equal(envPositiveInt("__TEST_LIMIT__", 42), 42);
    process.env.__TEST_LIMIT__ = "abc";
    assert.equal(envPositiveInt("__TEST_LIMIT__", 42), 42);
    process.env.__TEST_LIMIT__ = "0";
    assert.equal(envPositiveInt("__TEST_LIMIT__", 42), 42);
    process.env.__TEST_LIMIT__ = "-5";
    assert.equal(envPositiveInt("__TEST_LIMIT__", 42), 42);
    delete process.env.__TEST_LIMIT__;
  });

  it("envPositiveInt parses a positive integer override", () => {
    process.env.__TEST_LIMIT__ = "1234";
    assert.equal(envPositiveInt("__TEST_LIMIT__", 42), 1234);
    delete process.env.__TEST_LIMIT__;
  });

  it("uploadLimits exposes the documented defaults", () => {
    delete process.env.SNOWFLAKE_MAX_IMPORT_ROWS;
    delete process.env.MAX_EXCEL_ROWS_IN_MEMORY;
    delete process.env.MAX_ROWS_FOR_DATA_SUMMARY_PROFILE;
    assert.equal(uploadLimits.snowflakeMaxImportRows, 500_000);
    assert.equal(uploadLimits.maxExcelRowsInMemory, 1_000_000);
    assert.equal(uploadLimits.maxRowsForDataSummaryProfile, 300_000);
    assert.equal(uploadLimits.maxUploadBytes, 200 * 1024 * 1024);
    assert.equal(uploadLimits.chunkingThresholdBytes, 10 * 1024 * 1024);
    assert.equal(uploadLimits.largeFileThresholdBytes, 50 * 1024 * 1024);
    assert.equal(uploadLimits.maxRowsForAiAnalysis, 100_000);
  });

  it("uploadLimits getters re-read env, so overrides take effect live", () => {
    process.env.SNOWFLAKE_MAX_IMPORT_ROWS = "250000";
    assert.equal(uploadLimits.snowflakeMaxImportRows, 250_000);
    delete process.env.SNOWFLAKE_MAX_IMPORT_ROWS;
    assert.equal(uploadLimits.snowflakeMaxImportRows, 500_000);
  });
});
