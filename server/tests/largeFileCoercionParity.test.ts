import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { isDuckDBAvailable, initDuckDBEager } from "../lib/columnarStorage.js";
import { parseFile, applyUploadPipelineWithProfile } from "../lib/fileParser.js";
import { emptyDatasetProfile } from "../lib/datasetProfile.js";
import { processLargeFile, getDataForAnalysis } from "../lib/largeFileProcessor.js";

/** Remove the session's DuckDB file + sidecar WAL so tests leave no /tmp residue. */
async function cleanupSession(_sessionId: string, storagePath: string): Promise<void> {
  if (!storagePath) return;
  await fs.unlink(storagePath).catch(() => {});
  await fs.unlink(`${storagePath}.wal`).catch(() => {});
}

/**
 * Wave Dup3 · parity guard for the large-file ingest coercion gap (C1).
 *
 * The <50MB path (`parseFile` + `applyUploadPipelineWithProfile`) fully
 * canonicalises data: currency strings → numbers, lone "-" → 0, booleans →
 * "Yes"/"No". The ≥50MB path (`processLargeFile` → DuckDB `read_csv_auto`)
 * historically stored a currency-formatted numeric column as VARCHAR text, so
 * numeric aggregations TRY_CAST to NULL — a 51MB file disagreed with a 49MB
 * file. This pins that, behind the default-OFF `LARGE_FILE_COERCION_ENABLED`
 * flag, the two paths now agree on the value-correctness drivers.
 */

const COL_CURRENCY = "Revenue";
const COL_BOOL = "Active";
const COL_INT = "Units";
const COL_CAT = "Region";

/** Small in-memory CSV exercising currency, boolean, int and category cols. */
function makeCsvBuffer(): Buffer {
  const lines = [
    `${COL_CURRENCY},${COL_BOOL},${COL_INT},${COL_CAT}`,
    `"$1,234.56",TRUE,10,North`,
    `"₹2,000",FALSE,20,South`,
    `-,TRUE,30,North`,
    `3000,TRUE,40,East`,
  ];
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

/** Coerce a cell to a finite number or null (mirrors how a numeric measure reads). */
function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

function sumColumn(rows: Record<string, unknown>[], col: string): number {
  let total = 0;
  for (const r of rows) {
    const n = asNumber(r[col]);
    if (n !== null) total += n;
  }
  return total;
}

describe("Wave Dup3 · large-file coercion parity with the <50MB path", () => {
  it("currency SUM + boolean mapping match the small-file canonical path (flag ON)", async (t) => {
    await initDuckDBEager();
    if (!isDuckDBAvailable()) {
      t.skip("DuckDB unavailable in this environment — large-file coercion parity not exercised.");
      return;
    }

    // ---- Path A: small-file canonical pipeline ----
    const buffer = makeCsvBuffer();
    const parsed = await parseFile(buffer, "t.csv");
    const { data: pathARows, summary: pathASummary } = applyUploadPipelineWithProfile(
      parsed,
      emptyDatasetProfile(),
    );
    const pathASum = sumColumn(pathARows, COL_CURRENCY);

    // ---- Path B: large-file path with the coercion flag ON ----
    const prevFlag = process.env.LARGE_FILE_COERCION_ENABLED;
    const sessionId = `dup3-parity-on-${process.pid}-${Date.now()}`;
    let pathBRows: Record<string, unknown>[] = [];
    const pathBTypeByName = new Map<string, string>();
    let storagePath = "";
    try {
      process.env.LARGE_FILE_COERCION_ENABLED = "true";
      const result = await processLargeFile(buffer, sessionId, "t.csv");
      storagePath = result.storagePath;
      // `result.metadata.columns` carries the post-coercion DuckDB column types
      // (recomputed inside processLargeFile after the coercion pass) — no extra
      // DB handle needed, which avoids file-DB WAL contention with the handle
      // processLargeFile leaves open.
      for (const c of result.metadata.columns) pathBTypeByName.set(c.name, c.type);
      pathBRows = await getDataForAnalysis(sessionId);
    } finally {
      if (prevFlag === undefined) delete process.env.LARGE_FILE_COERCION_ENABLED;
      else process.env.LARGE_FILE_COERCION_ENABLED = prevFlag;
      await cleanupSession(sessionId, storagePath);
    }

    const pathBSum = sumColumn(pathBRows, COL_CURRENCY);

    // (a) currency column: numeric SUM equal in A and B; "-" contributed 0.
    // Expected: 1234.56 + 2000 + 0 + 3000 = 6234.56
    assert.ok(
      Math.abs(pathASum - 6234.56) < 1e-6,
      `Path A currency sum expected 6234.56, got ${pathASum}`,
    );
    assert.ok(
      Math.abs(pathASum - pathBSum) < 1e-6,
      `currency SUM must match across paths: A=${pathASum} B=${pathBSum}`,
    );

    // (b) boolean column: values are "Yes"/"No" in both.
    const aBoolVals = new Set(pathARows.map((r) => String(r[COL_BOOL])));
    const bBoolVals = new Set(pathBRows.map((r) => String(r[COL_BOOL])));
    for (const v of aBoolVals) {
      assert.ok(v === "Yes" || v === "No", `Path A boolean values must be Yes/No, saw "${v}"`);
    }
    for (const v of bBoolVals) {
      assert.ok(v === "Yes" || v === "No", `Path B boolean values must be Yes/No, saw "${v}"`);
    }
    // Exact per-row mapping: TRUE→Yes, FALSE→No.
    assert.deepEqual(
      pathBRows.map((r) => String(r[COL_BOOL])),
      ["Yes", "No", "Yes", "Yes"],
      "Path B boolean column must map TRUE→Yes / FALSE→No row-for-row",
    );

    // (c) currency column is a numeric type in B's table (not text).
    const curType = (pathBTypeByName.get(COL_CURRENCY) || "").toUpperCase();
    assert.ok(
      curType.includes("DOUBLE") ||
        curType.includes("DECIMAL") ||
        curType.includes("FLOAT") ||
        curType.includes("REAL"),
      `coerced currency column must be numeric in B, got "${curType}"`,
    );

    // Sanity: the small-file path classifies the currency column as numeric too.
    assert.ok(
      pathASummary.numericColumns.includes(COL_CURRENCY),
      "small-file path must classify the currency column as numeric",
    );
  });

  it("default-OFF: currency column stays VARCHAR / un-coerced (production behaviour unchanged)", async (t) => {
    await initDuckDBEager();
    if (!isDuckDBAvailable()) {
      t.skip("DuckDB unavailable in this environment — default-OFF guard not exercised.");
      return;
    }

    const buffer = makeCsvBuffer();
    const prevFlag = process.env.LARGE_FILE_COERCION_ENABLED;
    const sessionId = `dup3-parity-off-${process.pid}-${Date.now()}`;
    let curType = "";
    let storagePath = "";
    try {
      // Flag explicitly unset → default OFF.
      delete process.env.LARGE_FILE_COERCION_ENABLED;
      const result = await processLargeFile(buffer, sessionId, "t.csv");
      storagePath = result.storagePath;
      const col = result.metadata.columns.find((c) => c.name === COL_CURRENCY);
      curType = String(col?.type ?? "").toUpperCase();
    } finally {
      if (prevFlag === undefined) delete process.env.LARGE_FILE_COERCION_ENABLED;
      else process.env.LARGE_FILE_COERCION_ENABLED = prevFlag;
      await cleanupSession(sessionId, storagePath);
    }

    // With the flag OFF, read_csv_auto leaves the currency column as text.
    assert.ok(
      curType.includes("VARCHAR") || curType.includes("CHAR") || curType.includes("TEXT"),
      `with flag OFF the currency column must remain un-coerced text, got "${curType}"`,
    );
  });
});
