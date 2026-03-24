import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFlexibleDate } from "../lib/dateUtils.js";
import {
  applyUploadPipelineWithProfile,
  canonicalizeDateColumnValues,
  getAndClearLastCsvParseDiagnostics,
  parseFile,
  resolveApprovedDateColumns,
  resolveDateColumnsForUpload,
  resolveEffectiveDateColumns,
} from "../lib/fileParser.js";
import type { DatasetProfile } from "../lib/datasetProfile.js";

describe("parseFlexibleDate (heuristic + fallback)", () => {
  it("parses common date strings", () => {
    assert.ok(parseFlexibleDate("03/01/2015") instanceof Date);
    assert.ok(parseFlexibleDate("2015-01-13") instanceof Date);
    assert.ok(parseFlexibleDate("20150113") instanceof Date);
  });

  it("rejects plain all-digit non-date strings", () => {
    assert.equal(parseFlexibleDate("1234567890"), null);
  });

  it("returns the same Date when valid", () => {
    const d = new Date(2015, 0, 13);
    assert.strictEqual(parseFlexibleDate(d), d);
  });
});

describe("csv parse anomaly diagnostics", () => {
  it("captures mismatched column count warnings for malformed csv", async () => {
    const csv = [
      "Product Name,Sales,Order Date",
      "Eldon Expressions,48.86,2016-04-18",
      "Newell 322,2001,7,2016-04-19",
    ].join("\n");
    const out = await parseFile(Buffer.from(csv, "utf-8"), "bad.csv");
    assert.ok(out.length > 0);
    const diag = getAndClearLastCsvParseDiagnostics();
    assert.ok(diag, "expected parse diagnostics");
    assert.ok((diag?.mismatchedRows || 0) > 0);
  });
});

describe("upload date columns: LLM profile only", () => {
  it("resolveDateColumnsForUpload uses only profile.dateColumns", () => {
    const data = [
      { "Row ID": 100, "Ship Date": "07/01/2015", "Order Date": "03/01/2015" },
      { "Row ID": 101, "Ship Date": "08/01/2015", "Order Date": "04/01/2015" },
    ];
    const profile: DatasetProfile = {
      shortDescription: "x",
      dateColumns: ["Ship Date"],
      suggestedQuestions: [],
    };
    const cols = resolveDateColumnsForUpload(data, profile);
    assert.deepEqual(cols, ["Ship Date"]);
  });
});

describe("upload date enrichment never corrupts identifiers", () => {
  it("canonicalizeDateColumnValues ignores Row ID even if wrongly listed as date", () => {
    const data = [
      { "Row ID": 1, "Order Date": "03/01/2015" },
      { "Row ID": 2, "Order Date": "04/01/2015" },
    ];
    const before = data.map((r) => ({ ...r }));
    canonicalizeDateColumnValues(data, ["Row ID", "Order Date"]);
    assert.equal(data[0]!["Row ID"], before[0]!["Row ID"]);
    assert.equal(data[1]!["Row ID"], before[1]!["Row ID"]);
    assert.equal(data[0]!["Order Date"], "2015-03-01");
  });

  it("canonicalizeDateColumnValues parses and canonicalizes date strings in date columns", () => {
    const data = [
      { "Order Date": "03/01/2015" },
      { "Order Date": "2015-01-13" },
    ];
    canonicalizeDateColumnValues(data, ["Order Date"]);
    assert.equal(data[0]!["Order Date"], "2015-03-01");
    assert.equal(data[1]!["Order Date"], "2015-01-13");
  });

  it("resolveDateColumnsForUpload drops identifier cols from LLM profile", () => {
    const data = [
      { "Row ID": 100, "Ship Date": "07/01/2015" },
      { "Row ID": 101, "Ship Date": "08/01/2015" },
    ];
    const profile: DatasetProfile = {
      shortDescription: "x",
      dateColumns: ["Row ID", "Ship Date"],
      suggestedQuestions: [],
    };
    const cols = resolveDateColumnsForUpload(data, profile);
    assert.ok(!cols.includes("Row ID"));
    assert.deepEqual(cols, ["Ship Date"]);
  });

  it("resolveEffectiveDateColumns prefers Cleaned_* when dirty column was enriched", () => {
    const order = ["Period", "Sales"];
    const data = [
      { Period: "x", Sales: 1, Cleaned_Period: new Date("2025-01-01") },
      { Period: "y", Sales: 2, Cleaned_Period: new Date("2025-02-01") },
    ];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Period"],
      dirtyStringDateColumns: ["Period"],
      suggestedQuestions: [],
    };
    const cols = resolveEffectiveDateColumns(data, profile, order);
    assert.deepEqual(cols, ["Cleaned_Period"]);
  });

  it("resolveEffectiveDateColumns keeps source when Cleaned_* is missing", () => {
    const order = ["Period"];
    const data = [{ Period: "x" }];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Period"],
      dirtyStringDateColumns: ["Period"],
      suggestedQuestions: [],
    };
    const cols = resolveEffectiveDateColumns(data, profile, order);
    assert.deepEqual(cols, ["Period"]);
  });

  it("applyUploadPipelineWithProfile does not mutate non-whitelisted business fields", () => {
    const data = [
      { Sales: "03/01/2015", Profit: "1200", "Order ID": "A-1" },
      { Sales: "04/01/2015", Profit: "1500", "Order ID": "A-2" },
    ];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: [],
      suggestedQuestions: [],
    };
    const out = applyUploadPipelineWithProfile(data, profile);
    assert.equal(out.data[0]!.Sales, "03/01/2015");
    assert.equal(out.data[1]!.Sales, "04/01/2015");
  });

  it("resolveApprovedDateColumns allows LLM override for non-whitelisted names when parseable", () => {
    const data = [
      { Cycle: "2024-01-01", Sales: 1 },
      { Cycle: "2024-02-01", Sales: 2 },
      { Cycle: "2024-03-01", Sales: 3 },
    ];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Cycle"],
      suggestedQuestions: [],
    };
    const cols = resolveApprovedDateColumns(data, profile);
    assert.ok(cols.includes("Cycle"));
  });

  it("resolveApprovedDateColumns rejects non-whitelisted LLM overrides when not parseable", () => {
    const data = [
      { Cycle: "alpha", Sales: 1 },
      { Cycle: "beta", Sales: 2 },
      { Cycle: "gamma", Sales: 3 },
    ];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Cycle"],
      suggestedQuestions: [],
    };
    const cols = resolveApprovedDateColumns(data, profile);
    assert.ok(!cols.includes("Cycle"));
  });

  it("resolveApprovedDateColumns excludes identifier number variants", () => {
    const data = [
      { "Order No": "2024-01-01", "Invoice Number": "2024-02-01", "Ship Date": "2024-03-01" },
    ];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Order No", "Invoice Number", "Ship Date"],
      suggestedQuestions: [],
    };
    const cols = resolveApprovedDateColumns(data, profile);
    assert.ok(!cols.includes("Order No"));
    assert.ok(!cols.includes("Invoice Number"));
    assert.ok(cols.includes("Ship Date"));
  });
});
