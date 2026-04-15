import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ColumnarStorageService,
  SessionDataNotMaterializedError,
} from "../lib/columnarStorage.js";
import { executePivotQuery } from "../lib/pivotQueryService.js";
import type { ChatDocument } from "../models/chat.model.js";

async function setupSession(sessionId: string) {
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();

  const csv = [
    "Category,Sub-Category,Sales",
    "Technology,Phones,100",
    "Technology,Accessories,50",
    "Furniture,Chairs,200",
  ].join("\n");

  await storage.loadCsvFromBuffer(Buffer.from(csv, "utf8"));
  await storage.close();
}

test("pivotQueryService builds correct tree + caches results", async () => {
  const sessionId = `pivot_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await setupSession(sessionId);

  const request = {
    rowFields: ["Category", "Sub-Category"],
    colFields: [],
    filterFields: [],
    valueSpecs: [{ id: "meas_sales", field: "Sales", agg: "sum" }],
    rowSort: undefined,
  };

  const out1 = await executePivotQuery(sessionId, request, { dataVersion: 1 });
  assert.equal(out1.meta?.cacheHit, false);
  assert.equal(out1.meta?.cached, false);

  const model = out1.model;
  assert.equal(model.rowFields.length, 2);
  assert.equal(model.colKeys.length, 0);

  // Grand total should equal 350.
  assert.equal(model.tree.grandTotal.flatValues?.meas_sales, 350);

  // Find "Technology" -> "Phones"
  const techGroup = model.tree.nodes.find(
    (n: any) => n.type === "group" && n.label === "Technology"
  ) as any;
  assert.ok(techGroup);
  assert.equal(techGroup.subtotal.flatValues?.meas_sales, 150);

  const phonesLeaf = techGroup.children.find(
    (n: any) => n.type === "leaf" && n.label === "Phones"
  ) as any;
  assert.ok(phonesLeaf);
  assert.equal(phonesLeaf.values.flatValues?.meas_sales, 100);

  // Second call should hit cache and be fast.
  const out2 = await executePivotQuery(sessionId, request, { dataVersion: 1 });
  assert.equal(out2.meta?.cacheHit, true);
  assert.equal(out2.meta?.cached, true);

  // Cache hit ratio + basic p95 latency guard on repeated calls.
  const N = 10;
  const durations: number[] = [];
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const out = await executePivotQuery(sessionId, request, { dataVersion: 1 });
    const dt = Date.now() - t0;
    durations.push(dt);
    if (out.meta?.cacheHit) hits++;
  }

  durations.sort((a, b) => a - b);
  const p95Index = Math.floor(0.95 * (durations.length - 1));
  const p95 = durations[p95Index] ?? 0;

  // Expect mostly cached results.
  assert.ok(hits >= Math.floor(N * 0.9), `Expected >=90% cache hits, got ${hits}/${N}`);
  // Very loose latency guard (small dataset + in-memory cache).
  assert.ok(p95 < 500, `Expected p95 < 500ms, got ${p95}ms`);
});

test("pivotQueryService throws typed invariant error when data table missing", async () => {
  const sessionId = `pivot_missing_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  await storage.close();

  const request = {
    rowFields: ["Category"],
    colFields: [],
    filterFields: [],
    valueSpecs: [{ id: "meas_sales", field: "Sales", agg: "sum" as const }],
  };

  await assert.rejects(
    () => executePivotQuery(sessionId, request, { dataVersion: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof SessionDataNotMaterializedError);
      assert.equal((err as SessionDataNotMaterializedError).code, "SESSION_DATA_NOT_MATERIALIZED");
      assert.match((err as Error).message, /missing required DuckDB table "data"/);
      return true;
    }
  );
});

test("pivotQueryService rematerializes DuckDB when chat provided and data table missing", async () => {
  const sessionId = `pivot_remat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  await storage.close();

  const chat = {
    sessionId,
    username: "u@test",
    fileName: "f.csv",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    dataSummary: {
      rowCount: 3,
      columnCount: 3,
      columns: [
        { name: "Category", type: "string" as const },
        { name: "Sub-Category", type: "string" as const },
        { name: "Sales", type: "number" as const },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    },
    messages: [],
    charts: [],
    insights: [],
    rawData: [
      { Category: "Technology", "Sub-Category": "Phones", Sales: 100 },
      { Category: "Technology", "Sub-Category": "Accessories", Sales: 50 },
      { Category: "Furniture", "Sub-Category": "Chairs", Sales: 200 },
    ],
    sampleRows: [],
    columnStatistics: {},
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: "test",
      fileSize: 0,
      analysisVersion: "1",
    },
  } as ChatDocument;

  const request = {
    rowFields: ["Category", "Sub-Category"],
    colFields: [],
    filterFields: [],
    valueSpecs: [{ id: "meas_sales", field: "Sales", agg: "sum" as const }],
    rowSort: undefined,
  };

  const out = await executePivotQuery(sessionId, request, { dataVersion: 1, chat });
  assert.equal(out.model.tree.grandTotal.flatValues?.meas_sales, 350);
});

test("materializeAuthoritativeDataTable is idempotent and replaces data", async () => {
  const sessionId = `pivot_materialize_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  try {
    await storage.materializeAuthoritativeDataTable([
      { Category: "Technology", Sales: 100 },
      { Category: "Furniture", Sales: 200 },
    ]);

    let rows = await storage.executeQuery<{ count: number }>(
      "SELECT COUNT(*) as count FROM data"
    );
    assert.equal(Number(rows[0]?.count ?? 0), 2);

    // Re-materialize for same session with updated dataset; table should be replaced, not appended.
    await storage.materializeAuthoritativeDataTable([
      { Category: "Office Supplies", Sales: 300 },
    ]);

    rows = await storage.executeQuery<{ count: number }>(
      "SELECT COUNT(*) as count FROM data"
    );
    assert.equal(Number(rows[0]?.count ?? 0), 1);

    const cats = await storage.executeQuery<{ Category: string }>(
      'SELECT "Category" FROM data'
    );
    assert.deepEqual(cats.map((r) => r.Category), ["Office Supplies"]);
  } finally {
    await storage.close();
  }
});

test("columnar storage query results are JSON-safe for BIGINT/HUGEINT", async () => {
  const sessionId = `pivot_bigint_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  try {
    const out = await storage.executeQuery<{ small_int: number; huge_int: string }>(
      "SELECT CAST(42 AS BIGINT) as small_int, CAST(9223372036854775807 AS HUGEINT) as huge_int"
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.small_int, 42);
    assert.equal(typeof out[0]?.huge_int, "string");
    assert.equal(out[0]?.huge_int, "9223372036854775807");
    assert.doesNotThrow(() => JSON.stringify(out));
  } finally {
    await storage.close();
  }
});

test("pivot query uses full table rows without sample-style truncation", async () => {
  const sessionId = `pivot_full_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  try {
    // 2,500 rows to guard against accidental sample caps.
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      Category: i % 2 === 0 ? "Technology" : "Furniture",
      Sales: 1,
    }));
    await storage.materializeAuthoritativeDataTable(rows, { tableName: "data" });
  } finally {
    await storage.close();
  }

  const out = await executePivotQuery(
    sessionId,
    {
      rowFields: ["Category"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "meas_sales", field: "Sales", agg: "sum" }],
    },
    { dataVersion: 1 }
  );

  // Full-table total must be 2500 if no truncation is applied.
  assert.equal(out.model.tree.grandTotal.flatValues?.meas_sales, 2500);
});

test("pivot default row order is chronological for YYYY-MM keys when rowSort omitted", async () => {
  const sessionId = `pivot_time_sort_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  try {
    await storage.materializeAuthoritativeDataTable(
      [
        { MonthKey: "2024-03", Sales: 300 },
        { MonthKey: "2024-01", Sales: 100 },
        { MonthKey: "2024-02", Sales: 200 },
      ],
      { tableName: "data" }
    );
  } finally {
    await storage.close();
  }

  const out = await executePivotQuery(
    sessionId,
    {
      rowFields: ["MonthKey"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "meas_sales", field: "Sales", agg: "sum" }],
    },
    { dataVersion: 1 }
  );

  const labels = (out.model.tree.nodes as { label: string }[]).map((n) => n.label);
  assert.deepEqual(labels, ["2024-01", "2024-02", "2024-03"]);
});

test("pivot primary rowLabel sorts by time order ascending", async () => {
  const sessionId = `pivot_rowlabel_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  try {
    await storage.materializeAuthoritativeDataTable(
      [
        { MonthKey: "2024-03", Sales: 300 },
        { MonthKey: "2024-01", Sales: 100 },
        { MonthKey: "2024-02", Sales: 200 },
      ],
      { tableName: "data" }
    );
  } finally {
    await storage.close();
  }

  const out = await executePivotQuery(
    sessionId,
    {
      rowFields: ["MonthKey"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "meas_sales", field: "Sales", agg: "sum" }],
      rowSort: { primary: "rowLabel", direction: "asc" },
    },
    { dataVersion: 1 }
  );

  const labels = (out.model.tree.nodes as { label: string }[]).map((n) => n.label);
  assert.deepEqual(labels, ["2024-01", "2024-02", "2024-03"]);
});

test("pivotQueryService applies slice filter on row dimension via filterFields", async () => {
  const sessionId = `pivot_row_slice_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await setupSession(sessionId);

  const out = await executePivotQuery(
    sessionId,
    {
      rowFields: ["Category", "Sub-Category"],
      colFields: [],
      filterFields: ["Category"],
      filterSelections: { Category: ["Technology"] },
      valueSpecs: [{ id: "meas_sales", field: "Sales", agg: "sum" }],
    },
    { dataVersion: 42 }
  );

  assert.equal(out.model.tree.grandTotal.flatValues?.meas_sales, 150);
  const top = out.model.tree.nodes as { label: string }[];
  assert.equal(top.length, 1);
  assert.equal(top[0]!.label, "Technology");
});

test("pivot aggregates column present only after rematerialize (computed-column parity)", async () => {
  const sessionId = `pivot_computed_col_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  try {
    await storage.materializeAuthoritativeDataTable(
      [
        { Category: "A", Sales: 10, LagDays: 2 },
        { Category: "A", Sales: 20, LagDays: 4 },
      ],
      { tableName: "data" }
    );
  } finally {
    await storage.close();
  }

  const out = await executePivotQuery(
    sessionId,
    {
      rowFields: ["Category"],
      colFields: [],
      filterFields: [],
      valueSpecs: [
        { id: "meas_lag", field: "LagDays", agg: "mean" as const },
        { id: "meas_sales", field: "Sales", agg: "sum" as const },
      ],
    },
    { dataVersion: 1 }
  );

  assert.equal(out.model.tree.grandTotal.flatValues?.meas_lag, 3);
  assert.equal(out.model.tree.grandTotal.flatValues?.meas_sales, 30);
});

