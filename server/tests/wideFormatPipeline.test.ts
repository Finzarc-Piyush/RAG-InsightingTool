// End-to-end pipeline test: parseFile (CSV) → classifyDataset → meltDataset
// → createDataSummary → assert long-format dataset with currency tag.
//
// Mirrors the real upload pipeline at uploadQueue.ts L411 (the seam
// where the wide-format auto-melt runs). Pinned against the screenshot's
// Marico-VN shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFile,
  createDataSummary,
  finaliseCurrencyForColumn,
} from "../lib/fileParser.js";
import { classifyDataset } from "../lib/wideFormat/classifyDataset.js";
import { meltDataset } from "../lib/wideFormat/meltDataset.js";
import { applyWideFormatTransformToSummary } from "../lib/wideFormat/applyWideFormatToSummary.js";
import type { WideFormatTransform } from "../shared/schema.js";

function csv(rows: string[]): Buffer {
  return Buffer.from(rows.join("\n"), "utf-8");
}

describe("wide-format pipeline · Marico-VN shape end-to-end", () => {
  // 3 id cols + 6 period cols + 4 brand rows = 24 long rows after melt.
  const buf = csv([
    'Facts,Markets,Products,"Q1 23 - w/e 23/03/23","Q2 23 - w/e 22/06/23","Q3 23 - w/e 22/09/23","Q4 23 - w/e 23/12/23","Latest 12 Mths 2YA - w/e 23/12/23","YTD 2YA"',
    'Value Sales,Off VN,MARICO,"đ135,804,075,023","đ140,000,000,000","đ150,000,000,000","đ160,000,000,000","đ131,110,877,074","đ500,000,000,000"',
    'Value Sales,Off VN,OLIV,"đ36,073,526,133","đ40,000,000,000","đ45,000,000,000","đ50,000,000,000","đ40,874,904,511","đ150,000,000,000"',
    'Value Sales,Off VN,PURITE,"đ95,064,500,503","đ100,000,000,000","đ110,000,000,000","đ120,000,000,000","đ125,954,325,410","đ400,000,000,000"',
    'Value Sales,Off VN,LASHE,"đ8,173,678,371","đ9,000,000,000","đ10,000,000,000","đ11,000,000,000","đ15,343,580,909","đ40,000,000,000"',
  ]);

  it("parseFile coerces all currency strings to numbers", async () => {
    const data = await parseFile(buf, "marico-vn.csv");
    assert.equal(data.length, 4);
    for (const row of data) {
      assert.equal(typeof row["Q1 23 - w/e 23/03/23"], "number");
    }
  });

  it("classifyDataset detects pure_period shape", async () => {
    const data = await parseFile(buf, "marico-vn.csv");
    const headers = Object.keys(data[0] || {});
    const c = classifyDataset(headers);
    assert.equal(c.isWide, true);
    assert.equal(c.shape, "pure_period");
    assert.deepEqual(c.idColumns.sort(), ["Facts", "Markets", "Products"].sort());
    assert.equal(c.periodColumns.length, 6);
  });

  it("source columns carry VND currency tag (captured at parse time)", async () => {
    await parseFile(buf, "marico-vn.csv");
    // Tally is module-state; finaliseCurrencyForColumn reads it.
    for (const src of [
      "Q1 23 - w/e 23/03/23",
      "Latest 12 Mths 2YA - w/e 23/12/23",
      "YTD 2YA",
    ]) {
      const c = finaliseCurrencyForColumn(src);
      assert.ok(c, `expected currency for ${src}`);
      assert.equal(c!.isoCode, "VND");
      assert.equal(c!.symbol, "đ");
    }
  });

  it("meltDataset produces 24 long rows", async () => {
    const data = await parseFile(buf, "marico-vn.csv");
    const c = classifyDataset(Object.keys(data[0] || {}));
    const melted = meltDataset(data, c);
    assert.equal(melted.rows.length, 24);
    assert.equal(melted.summary.shape, "pure_period");

    // Every long row has the new long columns.
    for (const r of melted.rows) {
      assert.ok("Period" in r);
      assert.ok("PeriodIso" in r);
      assert.ok("PeriodKind" in r);
      assert.ok("Value" in r);
      assert.equal(typeof r.Value, "number");
    }

    // Q1-Q4 quarters + L12M-2YA + YTD-2YA are all represented.
    const isos = new Set(melted.rows.map((r) => r.PeriodIso));
    for (const expected of [
      "2023-Q1",
      "2023-Q2",
      "2023-Q3",
      "2023-Q4",
      "L12M-2YA",
      "YTD-2YA",
    ]) {
      assert.ok(isos.has(expected), `missing PeriodIso ${expected}`);
    }
  });

  it("post-melt + applyWideFormatTransformToSummary → numeric VND-tagged Value column", async () => {
    const data = await parseFile(buf, "marico-vn.csv");
    const c = classifyDataset(Object.keys(data[0] || {}));
    const melted = meltDataset(data, c);
    const summary = createDataSummary(melted.rows);
    const wideFormatTransform: WideFormatTransform = {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    };
    applyWideFormatTransformToSummary(summary, wideFormatTransform);

    // 7 logical columns expected.
    const userCols = summary.columns.filter((c) => !c.temporalFacetGrain);
    const names = new Set(userCols.map((c) => c.name));
    for (const expected of [
      "Facts",
      "Markets",
      "Products",
      "Period",
      "PeriodIso",
      "PeriodKind",
      "Value",
    ]) {
      assert.ok(names.has(expected), `expected column ${expected}`);
    }

    const valueCol = summary.columns.find((c) => c.name === "Value")!;
    assert.equal(valueCol.type, "number");
    assert.ok(summary.numericColumns.includes("Value"));
    assert.ok(valueCol.currency);
    assert.equal(valueCol.currency!.isoCode, "VND");
    assert.equal(valueCol.currency!.symbol, "đ");

    // wideFormatTransform metadata is on the summary.
    assert.ok(summary.wideFormatTransform);
    assert.equal(summary.wideFormatTransform!.detected, true);
    assert.equal(summary.wideFormatTransform!.shape, "pure_period");
    assert.equal(summary.wideFormatTransform!.detectedCurrencySymbol, "đ");
  });
});
