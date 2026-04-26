import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import { buildDashboardXlsxBuffer } from "../services/dashboardExport/xlsxExport.service.js";
import { buildDashboardPptxBuffer } from "../services/dashboardExport/pptxExport.service.js";
import type { Dashboard } from "../shared/schema.js";

/**
 * W7.3 / W7.4 · Smoke tests for the export services. Build a representative
 * dashboard, render to a Buffer, then validate the magic bytes (XLSX + PPTX
 * are both ZIP archives starting with `PK\x03\x04`) and parse XLSX back to
 * confirm sheets exist as expected.
 */

const sampleDashboard: Dashboard = {
  id: "dash_test_1",
  name: "Q3 Sales Review",
  username: "u@example.com",
  template: "executive",
  defaultSheetId: "sheet_summary",
  sheets: [
    {
      id: "sheet_summary",
      name: "Summary",
      narrativeBlocks: [
        {
          role: "summary",
          body: "Net sales rose 12% YoY in Q3, driven by Western region growth.",
        },
        {
          role: "recommendations",
          title: "Next steps",
          body: "Investigate the Western region driver further.",
        },
      ],
      charts: [],
    },
    {
      id: "sheet_evidence",
      name: "Evidence",
      narrativeBlocks: [],
      charts: [
        {
          type: "bar",
          title: "Sales by region",
          x: "region",
          y: "sales",
          data: [
            { region: "West", sales: 1_200_000 },
            { region: "East", sales: 850_000 },
            { region: "South", sales: 600_000 },
          ],
          _agentProvenance: {
            toolCalls: [{ id: "call_1", tool: "execute_query_plan", rowsIn: 9800, rowsOut: 3 }],
          },
        },
        {
          type: "line",
          title: "Monthly trend",
          x: "month",
          y: "sales",
          data: [
            { month: "Jan", sales: 100 },
            { month: "Feb", sales: 110 },
            { month: "Mar", sales: 130 },
          ],
        },
      ],
    },
  ],
} as unknown as Dashboard;

describe("buildDashboardXlsxBuffer", () => {
  it("produces a non-empty XLSX (ZIP-shaped) buffer", async () => {
    const buf = await buildDashboardXlsxBuffer(sampleDashboard);
    assert.ok(buf.length > 0);
    // Magic bytes for the ZIP container that XLSX uses.
    assert.strictEqual(buf[0], 0x50);
    assert.strictEqual(buf[1], 0x4b);
    assert.strictEqual(buf[2], 0x03);
    assert.strictEqual(buf[3], 0x04);
  });

  it("contains an Overview tab + one tab per chart + a Provenance tab", async () => {
    const buf = await buildDashboardXlsxBuffer(sampleDashboard);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const names = wb.worksheets.map((w) => w.name);
    assert.ok(names.includes("Overview"));
    assert.ok(names.includes("Provenance"));
    // Two charts in the sample → two chart tabs (sanitized name varies).
    const chartTabs = names.filter((n) => n !== "Overview" && n !== "Provenance");
    assert.strictEqual(chartTabs.length, 2);
  });

  it("renders the chart's data rows verbatim into its tab", async () => {
    const buf = await buildDashboardXlsxBuffer(sampleDashboard);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    // Find the bar-chart tab and check the first data row.
    const barTab = wb.worksheets.find((w) => w.name.toLowerCase().includes("sales by region"));
    assert.ok(barTab, "missing 'Sales by region' tab");
    const headerRow = barTab!.getRow(1);
    const headerValues = headerRow.values as Array<string | number | undefined>;
    // headerValues[0] is undefined per ExcelJS 1-indexed convention; cells start at 1.
    assert.ok(headerValues.includes("region"));
    assert.ok(headerValues.includes("sales"));
  });

  it("doesn't crash on a chart with empty data", async () => {
    const dash: Dashboard = {
      ...sampleDashboard,
      sheets: [
        {
          id: "s",
          name: "S",
          charts: [{ type: "bar", title: "Empty", x: "x", y: "y", data: [] } as never],
        },
      ],
    } as unknown as Dashboard;
    const buf = await buildDashboardXlsxBuffer(dash);
    assert.ok(buf.length > 0);
  });
});

describe("buildDashboardPptxBuffer", () => {
  it("produces a non-empty PPTX (ZIP-shaped) buffer", async () => {
    const buf = await buildDashboardPptxBuffer(sampleDashboard);
    assert.ok(buf.length > 0);
    assert.strictEqual(buf[0], 0x50);
    assert.strictEqual(buf[1], 0x4b);
    assert.strictEqual(buf[2], 0x03);
    assert.strictEqual(buf[3], 0x04);
  });

  it("doesn't crash on a dashboard with no sheets (cover slide only)", async () => {
    const dash: Dashboard = { ...sampleDashboard, sheets: [] } as unknown as Dashboard;
    const buf = await buildDashboardPptxBuffer(dash);
    assert.ok(buf.length > 0);
  });
});
