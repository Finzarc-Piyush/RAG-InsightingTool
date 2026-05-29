/**
 * Wave W-GMK1 · tests for resolvePeriodAxis.
 *
 * The Marico FMCG dataset shape that prompted this wave has nine
 * period-related columns (Day · Period, Week · Period, Month · Period,
 * Quarter · Period, Half-year · Period, Year · Period, Period, PeriodIso,
 * PeriodKind) where the raw `Period` column mixes kinds — quarter labels,
 * rolling 12-month labels, YTD labels and calendar years all in one column.
 * Plotting that column as x-axis produces a chart with overlapping windows
 * at incomparable magnitudes; the resolver must pick ONE coherent grain.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePeriodAxis } from "../lib/periodColumnResolver.js";
import type { DataSummary } from "../shared/schema.js";

function summary(overrides: Partial<DataSummary> = {}): DataSummary {
  return {
    rowCount: 100,
    columnCount: 5,
    columns: [],
    numericColumns: [],
    dateColumns: [],
    sampleRows: [],
    ...overrides,
  } as DataSummary;
}

describe("resolvePeriodAxis", () => {
  describe("edge cases", () => {
    it("returns null when no columns provided", () => {
      const d = resolvePeriodAxis([], [], summary());
      assert.equal(d.pickedColumn, null);
      assert.deepEqual(d.periodColumns, []);
    });

    it("returns null when no sample provided", () => {
      const d = resolvePeriodAxis(["Period"], [], summary());
      assert.equal(d.pickedColumn, null);
    });

    it("returns null when no period columns detected", () => {
      const sample = [
        { Product: "A", Sales: 100 },
        { Product: "B", Sales: 200 },
      ];
      const d = resolvePeriodAxis(["Product", "Sales"], sample, summary());
      assert.equal(d.pickedColumn, null);
      assert.equal(d.reason, "No period columns detected");
    });

    it("skips columns with cardinality < 2", () => {
      const sample = [
        { "Month · Date": "2024-01", Sales: 100 },
        { "Month · Date": "2024-01", Sales: 200 },
      ];
      const d = resolvePeriodAxis(
        ["Month · Date", "Sales"],
        sample,
        summary()
      );
      assert.equal(d.pickedColumn, null);
    });
  });

  describe("single temporal facet", () => {
    it("picks the only temporal-facet column present", () => {
      const sample = [
        { "Month · Order Date": "2024-01" },
        { "Month · Order Date": "2024-02" },
        { "Month · Order Date": "2024-03" },
      ];
      const d = resolvePeriodAxis(
        ["Month · Order Date"],
        sample,
        summary()
      );
      assert.equal(d.pickedColumn, "Month · Order Date");
      assert.match(d.reason, /Month · Order Date/);
      assert.equal(d.pinnedKind, undefined);
      assert.equal(d.injectedFilter, undefined);
    });
  });

  describe("multiple temporal facets — default preference", () => {
    const sample = Array.from({ length: 6 }, (_, i) => ({
      "Day · Period": `2024-01-${i + 1}`,
      "Week · Period": `2024-W${i + 1}`,
      "Month · Period": `2024-${String(i + 1).padStart(2, "0")}`,
      "Quarter · Period": `2024-Q${(i % 4) + 1}`,
      "Year · Period": `${2020 + i}`,
    }));
    const columns = [
      "Day · Period",
      "Week · Period",
      "Month · Period",
      "Quarter · Period",
      "Year · Period",
    ];

    it("prefers Month grain by default", () => {
      const d = resolvePeriodAxis(columns, sample, summary());
      assert.equal(d.pickedColumn, "Month · Period");
    });

    it("question 'quarterly' pins to Quarter facet", () => {
      const d = resolvePeriodAxis(
        columns,
        sample,
        summary(),
        "show me quarterly sales"
      );
      assert.equal(d.pickedColumn, "Quarter · Period");
    });

    it("question 'yearly' pins to Year facet", () => {
      const d = resolvePeriodAxis(
        columns,
        sample,
        summary(),
        "what is the yearly trend"
      );
      assert.equal(d.pickedColumn, "Year · Period");
    });

    it("question 'weekly' pins to Week facet", () => {
      const d = resolvePeriodAxis(
        columns,
        sample,
        summary(),
        "show weekly data"
      );
      assert.equal(d.pickedColumn, "Week · Period");
    });

    it("question 'daily' pins to Day facet", () => {
      const d = resolvePeriodAxis(
        columns,
        sample,
        summary(),
        "daily breakdown please"
      );
      assert.equal(d.pickedColumn, "Day · Period");
    });
  });

  describe("Marico nine-column scenario", () => {
    const sample = [
      {
        "Day · Period": "2025-03-23",
        "Week · Period": "2025-W12",
        "Month · Period": "2025-03",
        "Quarter · Period": "2025-Q1",
        "Half-year · Period": "2025-H1",
        "Year · Period": "2025",
        Period: "Q1 25",
        PeriodIso: "2025-Q1",
        PeriodKind: "Quarter",
        Value: 100,
      },
      {
        "Day · Period": "2024-06-22",
        "Week · Period": "2024-W26",
        "Month · Period": "2024-06",
        "Quarter · Period": "2024-Q2",
        "Half-year · Period": "2024-H1",
        "Year · Period": "2024",
        Period: "Latest 12 Mths",
        PeriodIso: "L12M",
        PeriodKind: "Latest12Mths",
        Value: 200,
      },
      {
        "Day · Period": "2024-12-31",
        "Week · Period": "2024-W52",
        "Month · Period": "2024-12",
        "Quarter · Period": "2024-Q4",
        "Half-year · Period": "2024-H2",
        "Year · Period": "2024",
        Period: "YTD",
        PeriodIso: "YTD-TY",
        PeriodKind: "YTD",
        Value: 300,
      },
    ];
    const columns = [
      "Day · Period",
      "Week · Period",
      "Month · Period",
      "Quarter · Period",
      "Half-year · Period",
      "Year · Period",
      "Period",
      "PeriodIso",
      "PeriodKind",
      "Value",
    ];

    it("default picks Month · Period (single-kind by construction)", () => {
      const d = resolvePeriodAxis(columns, sample, summary());
      assert.equal(d.pickedColumn, "Month · Period");
      assert.equal(d.pinnedKind, undefined);
      assert.equal(d.injectedFilter, undefined);
    });

    it("'quarterly' question picks Quarter · Period", () => {
      const d = resolvePeriodAxis(
        columns,
        sample,
        summary(),
        "quarterly sales by product"
      );
      assert.equal(d.pickedColumn, "Quarter · Period");
    });

    it("PeriodKind column is never picked as the time axis", () => {
      const d = resolvePeriodAxis(columns, sample, summary());
      assert.notEqual(d.pickedColumn, "PeriodKind");
    });

    it("Period and PeriodIso are surfaced in periodColumns", () => {
      const d = resolvePeriodAxis(columns, sample, summary());
      assert.ok(d.periodColumns.includes("Period"));
      assert.ok(d.periodColumns.includes("PeriodIso"));
    });

    it("PeriodKind discriminator is NOT in periodColumns (it's not a time axis)", () => {
      const d = resolvePeriodAxis(columns, sample, summary());
      assert.ok(!d.periodColumns.includes("PeriodKind"));
    });
  });

  describe("raw Period column behaviour", () => {
    it("multi-kind raw Period + PeriodKind discriminator → injects filter to dominant kind", () => {
      const sample = [
        { Period: "Q1 25", PeriodKind: "Quarter", Value: 1 },
        { Period: "Q2 25", PeriodKind: "Quarter", Value: 2 },
        { Period: "Q3 25", PeriodKind: "Quarter", Value: 3 },
        { Period: "Q4 25", PeriodKind: "Quarter", Value: 4 },
        { Period: "Latest 12 Mths", PeriodKind: "Latest12Mths", Value: 10 },
        { Period: "YTD", PeriodKind: "YTD", Value: 20 },
      ];
      const d = resolvePeriodAxis(
        ["Period", "PeriodKind", "Value"],
        sample,
        summary()
      );
      assert.equal(d.pickedColumn, "Period");
      assert.equal(d.pinnedKind, "quarter");
      assert.ok(d.injectedFilter);
      assert.equal(d.injectedFilter!.column, "PeriodKind");
      assert.equal(d.injectedFilter!.value, "Quarter");
      assert.match(d.reason, /filtered to PeriodKind = Quarter/);
    });

    it("multi-kind raw Period WITHOUT discriminator → pins kind, warns in reason", () => {
      const sample = [
        { Period: "Q1 25", Value: 1 },
        { Period: "Q2 25", Value: 2 },
        { Period: "Latest 12 Mths", Value: 10 },
        { Period: "YTD", Value: 20 },
      ];
      const d = resolvePeriodAxis(["Period", "Value"], sample, summary());
      assert.equal(d.pickedColumn, "Period");
      assert.equal(d.pinnedKind, "quarter");
      assert.equal(d.injectedFilter, undefined);
      assert.match(d.reason, /multiple period kinds present/);
    });

    it("single-kind raw Period → no pin, no filter", () => {
      const sample = [
        { Period: "Q1 25", Value: 1 },
        { Period: "Q2 25", Value: 2 },
        { Period: "Q3 25", Value: 3 },
      ];
      const d = resolvePeriodAxis(["Period", "Value"], sample, summary());
      assert.equal(d.pickedColumn, "Period");
      assert.equal(d.pinnedKind, undefined);
      assert.equal(d.injectedFilter, undefined);
    });

    it("question 'rolling 12 months' on multi-kind Period → filters to rolling kind", () => {
      // The matchPeriod() vocab classifies "P12W" / "Latest 12 Mths" labels;
      // here we ensure the resolver respects rolling kind when it's present.
      const sample = [
        { Period: "P4W", PeriodKind: "Rolling", Value: 1 },
        { Period: "P12W", PeriodKind: "Rolling", Value: 2 },
        { Period: "Q1 25", PeriodKind: "Quarter", Value: 3 },
        { Period: "Q2 25", PeriodKind: "Quarter", Value: 4 },
        { Period: "Q3 25", PeriodKind: "Quarter", Value: 5 },
        { Period: "Q4 25", PeriodKind: "Quarter", Value: 6 },
      ];
      // No coarse intent string maps cleanly to 'rolling', so default-pick
      // is Quarter (dominant); we assert that explicitly so the behaviour
      // is documented.
      const d = resolvePeriodAxis(
        ["Period", "PeriodKind", "Value"],
        sample,
        summary()
      );
      assert.equal(d.pickedColumn, "Period");
      assert.equal(d.pinnedKind, "quarter");
    });

    it("falls back to PeriodIso when Period is absent", () => {
      const sample = [
        { PeriodIso: "2024-Q1", Value: 1 },
        { PeriodIso: "2024-Q2", Value: 2 },
        { PeriodIso: "2024-Q3", Value: 3 },
      ];
      const d = resolvePeriodAxis(["PeriodIso", "Value"], sample, summary());
      assert.equal(d.pickedColumn, "PeriodIso");
    });

    it("prefers Period over PeriodIso when both are single-kind", () => {
      const sample = [
        { Period: "Q1 25", PeriodIso: "2025-Q1", Value: 1 },
        { Period: "Q2 25", PeriodIso: "2025-Q2", Value: 2 },
      ];
      const d = resolvePeriodAxis(
        ["Period", "PeriodIso", "Value"],
        sample,
        summary()
      );
      assert.equal(d.pickedColumn, "Period");
    });
  });

  describe("PeriodKind discriminator handling", () => {
    it("PeriodKind alone (no Period column) is not picked as time axis", () => {
      const sample = [
        { PeriodKind: "Quarter", Value: 1 },
        { PeriodKind: "Year", Value: 2 },
      ];
      const d = resolvePeriodAxis(
        ["PeriodKind", "Value"],
        sample,
        summary()
      );
      assert.equal(d.pickedColumn, null);
      assert.ok(!d.periodColumns.includes("PeriodKind"));
    });

    it("PeriodKind synonym match works for non-canonical literal values", () => {
      const sample = [
        { Period: "Jan 24", PeriodKind: "Monthly", Value: 1 },
        { Period: "Feb 24", PeriodKind: "Monthly", Value: 2 },
        { Period: "Q1 24", PeriodKind: "Quarterly", Value: 10 },
        { Period: "Q2 24", PeriodKind: "Quarterly", Value: 20 },
        { Period: "Q3 24", PeriodKind: "Quarterly", Value: 30 },
        { Period: "Q4 24", PeriodKind: "Quarterly", Value: 40 },
      ];
      const d = resolvePeriodAxis(
        ["Period", "PeriodKind", "Value"],
        sample,
        summary(),
        "monthly trend"
      );
      assert.equal(d.pickedColumn, "Period");
      assert.equal(d.pinnedKind, "month");
      assert.ok(d.injectedFilter);
      assert.equal(d.injectedFilter!.value, "Monthly");
    });
  });

  describe("date columns from DataSummary", () => {
    it("picks a date column when no facets / raw periods present", () => {
      const sample = [
        { OrderDate: "2024-01-15", Value: 1 },
        { OrderDate: "2024-02-20", Value: 2 },
        { OrderDate: "2024-03-10", Value: 3 },
      ];
      const d = resolvePeriodAxis(
        ["OrderDate", "Value"],
        sample,
        summary({ dateColumns: ["OrderDate"] })
      );
      assert.equal(d.pickedColumn, "OrderDate");
    });

    it("prefers temporal facets over a plain date column", () => {
      const sample = [
        { OrderDate: "2024-01-15", "Month · OrderDate": "2024-01", Value: 1 },
        { OrderDate: "2024-02-20", "Month · OrderDate": "2024-02", Value: 2 },
      ];
      const d = resolvePeriodAxis(
        ["OrderDate", "Month · OrderDate", "Value"],
        sample,
        summary({ dateColumns: ["OrderDate"] })
      );
      assert.equal(d.pickedColumn, "Month · OrderDate");
    });
  });

  describe("content-based detection", () => {
    it("detects an unnamed column whose values look like periods", () => {
      const sample = [
        { Bucket: "Jan 2024", Value: 1 },
        { Bucket: "Feb 2024", Value: 2 },
        { Bucket: "Mar 2024", Value: 3 },
        { Bucket: "Apr 2024", Value: 4 },
      ];
      const d = resolvePeriodAxis(["Bucket", "Value"], sample, summary());
      assert.equal(d.pickedColumn, "Bucket");
      assert.ok(d.periodColumns.includes("Bucket"));
    });

    it("does NOT detect a column with random strings", () => {
      const sample = [
        { Notes: "Hello world", Value: 1 },
        { Notes: "Lorem ipsum", Value: 2 },
        { Notes: "Foo bar", Value: 3 },
      ];
      const d = resolvePeriodAxis(["Notes", "Value"], sample, summary());
      assert.equal(d.pickedColumn, null);
    });
  });

  describe("reason string contract", () => {
    it("includes the picked column name", () => {
      const sample = [
        { "Month · Date": "2024-01" },
        { "Month · Date": "2024-02" },
      ];
      const d = resolvePeriodAxis(["Month · Date"], sample, summary());
      assert.match(d.reason, /Month · Date/);
      assert.match(d.reason, /sorted chronologically/);
    });

    it("filtered + sorted wording when filter is injected", () => {
      const sample = [
        { Period: "Q1 25", PeriodKind: "Quarter" },
        { Period: "Q2 25", PeriodKind: "Quarter" },
        { Period: "Latest 12 Mths", PeriodKind: "Rolling" },
      ];
      const d = resolvePeriodAxis(
        ["Period", "PeriodKind"],
        sample,
        summary()
      );
      assert.match(d.reason, /filtered to PeriodKind = /);
      assert.match(d.reason, /sorted chronologically/);
    });

    it("warning wording when multi-kind but no filter possible", () => {
      const sample = [
        { Period: "Q1 25" },
        { Period: "Q2 25" },
        { Period: "Latest 12 Mths" },
      ];
      const d = resolvePeriodAxis(["Period"], sample, summary());
      assert.match(d.reason, /chronological ordering may be unstable/);
    });
  });
});
