import { test } from "node:test";
import assert from "node:assert/strict";
import { MetadataService } from "../lib/metadataService.js";

/**
 * TG7 · The columnar/metadata reload path (convertToDataSummary) used to omit
 * per-column dateRange, which silently forced every span-aware grain decision to
 * Month-first — the root cause of the single-month-daily dashboard collapse. It
 * must now backfill dateRange from the sample rows.
 */
test("convertToDataSummary backfills dateRange from sample rows", () => {
  const svc = new MetadataService();
  const sampleRows = Array.from({ length: 30 }, (_, i) => ({
    Date: `2026-04-${String(i + 1).padStart(2, "0")}`,
    Sales: 100 + i,
  }));
  const metadata = {
    rowCount: 30,
    columnCount: 2,
    columns: [
      { name: "Date", type: "DATE" },
      { name: "Sales", type: "INTEGER" },
    ],
  } as unknown as Parameters<MetadataService["convertToDataSummary"]>[0];

  const summary = svc.convertToDataSummary(metadata, sampleRows);
  const dateCol = summary.columns.find((c) => c.name === "Date") as {
    dateRange?: { spanDays: number; distinctDayCount: number };
  };
  assert.ok(dateCol.dateRange, "expected dateRange backfilled on the Date column");
  assert.equal(dateCol.dateRange!.distinctDayCount, 30);
  assert.ok(
    dateCol.dateRange!.spanDays >= 28 && dateCol.dateRange!.spanDays <= 30,
    `spanDays ${dateCol.dateRange!.spanDays} should be ~29`,
  );
});

test("convertToDataSummary leaves non-date columns without dateRange", () => {
  const svc = new MetadataService();
  const summary = new MetadataService().convertToDataSummary(
    {
      rowCount: 1,
      columnCount: 1,
      columns: [{ name: "Sales", type: "INTEGER" }],
    } as unknown as Parameters<MetadataService["convertToDataSummary"]>[0],
    [{ Sales: 1 }],
  );
  const col = summary.columns.find((c) => c.name === "Sales") as {
    dateRange?: unknown;
  };
  assert.equal(col.dateRange, undefined);
  void svc;
});
