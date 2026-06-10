import { test } from "node:test";
import assert from "node:assert/strict";
import { ColumnarStorageService } from "../lib/columnarStorage.js";
import {
  executePivotQuery,
  pickRenderableValueSpecs,
} from "../lib/pivotQueryService.js";

test("pickRenderableValueSpecs keeps only fields present on the table", () => {
  const specs = [
    { id: "a", field: "Sales", agg: "sum" },
    { id: "b", field: "pjp_adherence_rate", agg: "sum" },
    { id: "c", field: "matching", agg: "sum" },
  ];
  const kept = pickRenderableValueSpecs(specs, ["Category", "Sales"]);
  assert.deepEqual(kept.map((s) => s.field), ["Sales"]);

  // All-invalid → empty (caller degrades to a rows-only pivot).
  assert.deepEqual(
    pickRenderableValueSpecs(specs, ["Category"]),
    [],
  );
});

async function setupSession(sessionId: string) {
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();
  const csv = [
    "Category,Sales",
    "Technology,100",
    "Furniture,200",
  ].join("\n");
  await storage.loadCsvFromBuffer(Buffer.from(csv, "utf8"));
  await storage.close();
}

test("executePivotQuery drops a nonexistent measure instead of throwing a binder error", async () => {
  const sessionId = `pivot_guard_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await setupSession(sessionId);

  // `pjp_adherence_rate` is NOT a real column — pre-fix this threw a DuckDB
  // binder error surfaced as "Couldn't load pivot".
  const request = {
    rowFields: ["Category"],
    colFields: [],
    filterFields: [],
    valueSpecs: [
      { id: "meas_sales", field: "Sales", agg: "sum" },
      { id: "meas_rate", field: "pjp_adherence_rate", agg: "sum" },
    ],
    rowSort: undefined,
  };

  const out = await executePivotQuery(sessionId, request, { dataVersion: 1 });
  // The valid measure still aggregates; the bogus one is silently dropped.
  assert.equal(out.model.valueSpecs.length, 1);
  assert.equal(out.model.valueSpecs[0].field, "Sales");
});

test("executePivotQuery degrades to a rows-only pivot when every measure is invalid", async () => {
  const sessionId = `pivot_guard_all_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await setupSession(sessionId);

  const request = {
    rowFields: ["Category"],
    colFields: [],
    filterFields: [],
    valueSpecs: [{ id: "meas_rate", field: "pjp_adherence_rate", agg: "sum" }],
    rowSort: undefined,
  };

  const out = await executePivotQuery(sessionId, request, { dataVersion: 1 });
  assert.equal(out.model.valueSpecs.length, 0);
  assert.ok(out.model.rowFields.includes("Category"));
});
