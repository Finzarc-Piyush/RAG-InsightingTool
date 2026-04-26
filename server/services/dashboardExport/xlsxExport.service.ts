/**
 * W7.4 · XLSX export of a saved Dashboard.
 *
 * Layout:
 *   - "Overview" tab: dashboard meta (name, template, sheet count, chart count, generation timestamp).
 *   - One tab per chart: header row from the chart's data keys + data rows.
 *   - "Provenance" tab: every chart's _agentProvenance for audit ("which tool produced this").
 *
 * Charts whose `data` is empty become a tab with a single info row so users
 * still see the chart in the export and know it was data-less in the source
 * dashboard rather than dropped.
 */

import ExcelJS from "exceljs";
import type { Dashboard, ChartSpec } from "../../shared/schema.js";

const MAX_SHEET_NAME = 31; // Excel cap

/** Excel cell-friendly value: pass numbers/booleans through; stringify the rest. */
function toCell(v: unknown): string | number | boolean | Date | null {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Excel sheet names: max 31 chars, can't contain `\ / ? * [ ]`. Dedupe by
 * appending a counter when collisions occur.
 */
function sanitizeSheetName(raw: string, used: Set<string>): string {
  let name = (raw || "Sheet").replace(/[\\/?*\[\]:]/g, " ").trim();
  if (!name) name = "Sheet";
  if (name.length > MAX_SHEET_NAME) name = name.slice(0, MAX_SHEET_NAME);
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = name.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function collectCharts(dashboard: Dashboard): Array<{
  sheetName: string;
  chartTitle: string;
  chart: ChartSpec;
}> {
  const out: Array<{ sheetName: string; chartTitle: string; chart: ChartSpec }> = [];
  for (const sheet of dashboard.sheets || []) {
    for (const chart of sheet.charts || []) {
      out.push({
        sheetName: sheet.name || sheet.id || "Sheet",
        chartTitle: chart.title || `${chart.type ?? "chart"}`,
        chart,
      });
    }
  }
  return out;
}

/** Build the workbook and return it as a Buffer ready to send to the client. */
export async function buildDashboardXlsxBuffer(dashboard: Dashboard): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Marico Insighting Tool";
  wb.created = new Date();

  const usedNames = new Set<string>();

  // ── Overview
  const overview = wb.addWorksheet(sanitizeSheetName("Overview", usedNames));
  overview.columns = [
    { header: "Field", key: "field", width: 28 },
    { header: "Value", key: "value", width: 60 },
  ];
  overview.getRow(1).font = { bold: true };
  const charts = collectCharts(dashboard);
  const rows: Array<[string, string | number]> = [
    ["Dashboard name", dashboard.name],
    ["Sheets", dashboard.sheets?.length ?? 0],
    ["Charts", charts.length],
    ["Generated at", new Date().toISOString()],
  ];
  for (const [field, value] of rows) overview.addRow({ field, value });

  // ── One tab per chart
  for (const { sheetName: parentName, chartTitle, chart } of charts) {
    const tab = wb.addWorksheet(
      sanitizeSheetName(`${parentName} · ${chartTitle}`, usedNames)
    );
    const data = (chart as { data?: Array<Record<string, unknown>> }).data;
    if (!data || data.length === 0) {
      tab.addRow([`No data attached to chart "${chartTitle}".`]);
      tab.addRow([`Chart type: ${chart.type ?? "(unknown)"}`]);
      tab.addRow([`Open the dashboard in the app to refresh data.`]);
      continue;
    }
    // Headers: union of keys across rows so partial rows don't lose columns.
    const headerSet = new Set<string>();
    for (const row of data) for (const k of Object.keys(row ?? {})) headerSet.add(k);
    const headers = [...headerSet];
    tab.columns = headers.map((h) => ({ header: h, key: h, width: 18 }));
    tab.getRow(1).font = { bold: true };
    for (const row of data) {
      const out: Record<string, unknown> = {};
      for (const h of headers) out[h] = toCell((row as Record<string, unknown>)[h]);
      tab.addRow(out);
    }
  }

  // ── Provenance tab
  const prov = wb.addWorksheet(sanitizeSheetName("Provenance", usedNames));
  prov.columns = [
    { header: "Sheet", key: "sheet", width: 20 },
    { header: "Chart", key: "chart", width: 32 },
    { header: "Tool", key: "tool", width: 28 },
    { header: "Tool call id", key: "callId", width: 28 },
    { header: "Rows in", key: "rowsIn", width: 12 },
    { header: "Rows out", key: "rowsOut", width: 12 },
  ];
  prov.getRow(1).font = { bold: true };
  for (const { sheetName: parentName, chartTitle, chart } of charts) {
    const calls = (chart as { _agentProvenance?: { toolCalls?: Array<{ id: string; tool: string; rowsIn?: number; rowsOut?: number }> } })
      ._agentProvenance?.toolCalls;
    if (!calls || calls.length === 0) {
      prov.addRow({ sheet: parentName, chart: chartTitle, tool: "(none recorded)" });
      continue;
    }
    for (const c of calls) {
      prov.addRow({
        sheet: parentName,
        chart: chartTitle,
        tool: c.tool,
        callId: c.id,
        rowsIn: c.rowsIn ?? null,
        rowsOut: c.rowsOut ?? null,
      });
    }
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}
