/* Throwaway: render new chartSsr output to SVG for visual QA. */
import { writeFileSync, mkdirSync } from "node:fs";
import { renderChartSpecToSvg } from "./lib/exports/chartSsr.js";
import type { ChartSpec } from "./shared/schema.js";

const OUT = "/tmp/ppt-new";
mkdirSync(OUT, { recursive: true });

const ms = (x: ChartSpec): ChartSpec => x;
const msData = [
  { Quarter: "2023-Q1", Brand: "Parachute", Sales: 40 }, { Quarter: "2023-Q1", Brand: "Saffola", Sales: 28 }, { Quarter: "2023-Q1", Brand: "Nihar", Sales: 12 },
  { Quarter: "2023-Q2", Brand: "Parachute", Sales: 44 }, { Quarter: "2023-Q2", Brand: "Saffola", Sales: 30 }, { Quarter: "2023-Q2", Brand: "Nihar", Sales: 14 },
  { Quarter: "2023-Q3", Brand: "Parachute", Sales: 36 }, { Quarter: "2023-Q3", Brand: "Saffola", Sales: 25 }, { Quarter: "2023-Q3", Brand: "Nihar", Sales: 10 },
  { Quarter: "2023-Q4", Brand: "Parachute", Sales: 48 }, { Quarter: "2023-Q4", Brand: "Saffola", Sales: 32 }, { Quarter: "2023-Q4", Brand: "Nihar", Sales: 16 },
];

const charts: Record<string, ChartSpec> = {
  bar_single: ms({ type: "bar", title: "Quarterly net sales", x: "Quarter", y: "Sales", xLabel: "Quarter", yLabel: "Net sales (₫B)",
    data: [{ Quarter: "2023-Q1", Sales: 68.7 }, { Quarter: "2023-Q2", Sales: 74.2 }, { Quarter: "2023-Q3", Sales: 61.0 }, { Quarter: "2023-Q4", Sales: 80.5 }] }),
  bar_grouped: ms({ type: "bar", title: "Net sales by brand", x: "Quarter", y: "Sales", seriesColumn: "Brand", barLayout: "grouped", xLabel: "Quarter", yLabel: "Net sales (₫B)", data: msData }),
  bar_stacked: ms({ type: "bar", title: "Net sales by brand (stacked)", x: "Quarter", y: "Sales", seriesColumn: "Brand", barLayout: "stacked", yLabel: "Net sales (₫B)", data: msData }),
  line_multi: ms({ type: "line", title: "Sales trend by brand", x: "Quarter", y: "Sales", seriesColumn: "Brand", yLabel: "Net sales (₫B)", data: msData }),
  area_single: ms({ type: "area", title: "Distribution growth", x: "Month", y: "Stores", yLabel: "Active stores",
    data: [{ Month: "Jan", Stores: 2100 }, { Month: "Feb", Stores: 2240 }, { Month: "Mar", Stores: 2190 }, { Month: "Apr", Stores: 2410 }, { Month: "May", Stores: 2520 }, { Month: "Jun", Stores: 2680 }] }),
  pie: ms({ type: "pie", title: "Category share", x: "Brand", y: "Share", yLabel: "Share %",
    data: [{ Brand: "Parachute", Share: 41 }, { Brand: "Saffola", Share: 27 }, { Brand: "Nihar", Share: 14 }, { Brand: "Marico Others", Share: 18 }] }),
  scatter: ms({ type: "scatter", title: "Price vs velocity", x: "Price", y: "Velocity", xLabel: "Price (₫)", yLabel: "Units / store / week",
    data: [{ Price: 20, Velocity: 80 }, { Price: 35, Velocity: 60 }, { Price: 50, Velocity: 52 }, { Price: 65, Velocity: 38 }, { Price: 80, Velocity: 30 }, { Price: 95, Velocity: 22 }],
    trendLine: [{ Price: 20, Velocity: 78 }, { Price: 95, Velocity: 24 }] } as unknown as ChartSpec),
  dual_axis: ms({ type: "bar", title: "Sales vs margin", x: "Quarter", y: "Sales", y2: "Margin", yLabel: "Net sales (₫B)", y2Label: "Margin %",
    data: [{ Quarter: "2023-Q1", Sales: 68.7, Margin: 0.31 }, { Quarter: "2023-Q2", Sales: 74.2, Margin: 0.33 }, { Quarter: "2023-Q3", Sales: 61.0, Margin: 0.28 }, { Quarter: "2023-Q4", Sales: 80.5, Margin: 0.35 }] } as unknown as ChartSpec),
  heatmap: ms({ type: "heatmap", title: "Promo response", x: "Region", y: "Brand", z: "Lift", xLabel: "Region", yLabel: "Brand",
    data: [
      { Region: "North", Brand: "Parachute", Lift: 12 }, { Region: "South", Brand: "Parachute", Lift: 8 }, { Region: "East", Brand: "Parachute", Lift: 15 },
      { Region: "North", Brand: "Saffola", Lift: 5 }, { Region: "South", Brand: "Saffola", Lift: 18 }, { Region: "East", Brand: "Saffola", Lift: 9 },
      { Region: "North", Brand: "Nihar", Lift: 3 }, { Region: "South", Brand: "Nihar", Lift: 6 }, { Region: "East", Brand: "Nihar", Lift: 11 },
    ] } as unknown as ChartSpec),
};

for (const [name, spec] of Object.entries(charts)) {
  const svg = renderChartSpecToSvg(spec, { width: 1000, height: 560, suppressTitle: true });
  if (svg) { writeFileSync(`${OUT}/${name}.svg`, svg); console.log(`ok ${name} (${svg.length}b)`); }
  else console.log(`NULL ${name}`);
}
