/* Throwaway: build a one-slide-per-layout deck directly (no LLM) for visual QA. */
import { writeFileSync } from "node:fs";
import { renderDeckPlanToPptxBuffer } from "./lib/exports/pptx/render.js";
import { LAYOUT_KIND, type SlideDeckPlan } from "./shared/exportSchema.js";
import type { Dashboard, ChartSpec } from "./shared/schema.js";

const ms = (x: ChartSpec): ChartSpec => x;

const charts: ChartSpec[] = [
  ms({ type: "bar", title: "Net sales by brand", x: "Quarter", y: "Sales",
    seriesColumn: "Brand", barLayout: "grouped", xLabel: "Quarter", yLabel: "Net sales (₫B)",
    data: [
      { Quarter: "2023-Q1", Brand: "Parachute", Sales: 40 }, { Quarter: "2023-Q1", Brand: "Saffola", Sales: 28 }, { Quarter: "2023-Q1", Brand: "Nihar", Sales: 12 },
      { Quarter: "2023-Q2", Brand: "Parachute", Sales: 44 }, { Quarter: "2023-Q2", Brand: "Saffola", Sales: 30 }, { Quarter: "2023-Q2", Brand: "Nihar", Sales: 14 },
      { Quarter: "2023-Q3", Brand: "Parachute", Sales: 36 }, { Quarter: "2023-Q3", Brand: "Saffola", Sales: 25 }, { Quarter: "2023-Q3", Brand: "Nihar", Sales: 10 },
      { Quarter: "2023-Q4", Brand: "Parachute", Sales: 48 }, { Quarter: "2023-Q4", Brand: "Saffola", Sales: 32 }, { Quarter: "2023-Q4", Brand: "Nihar", Sales: 16 },
    ] }),
  ms({ type: "pie", title: "Category share", x: "Brand", y: "Share",
    data: [ { Brand: "Parachute", Share: 41 }, { Brand: "Saffola", Share: 27 }, { Brand: "Nihar", Share: 14 }, { Brand: "Others", Share: 18 } ] }),
];

const dashboard: Dashboard = {
  id: "dash-demo", username: "demo@marico", name: "Marico-VN · Q3 category review",
  createdAt: 1_730_000_000_000, updatedAt: 1_730_000_000_000, charts: [],
  sheets: [{ id: "s0", name: "Overview", order: 0, charts,
    tables: [{ caption: "Top SKUs", columns: ["SKU", "Units", "Value (₫)", "Share"],
      rows: [["Parachute 200ml", 124000, 1234567.89, 0.41], ["Saffola Gold 1L", 88000, 987654.32, 0.27], ["Nihar 100ml", 45000, 456789.01, 0.14]] }] }],
} as unknown as Dashboard;

const plan: SlideDeckPlan = {
  title: "Marico-VN · category leadership · Q3 review",
  subtitle: "How did MARICO's share move within female shower gel in Q3?",
  generatedAt: "2026-06-18", confidentiality: "Internal", preparedFor: "Marico VN Insights",
  slides: [
    { layout: LAYOUT_KIND.TitleSlide, actionTitle: "Marico-VN · category leadership · Q3 review",
      speakerNotes: "Cover slide for the Q3 category review of Marico Vietnam.", slots: { subtitle: "How did MARICO's share move within female shower gel in Q3?", confidentiality: "Internal" } },
    { layout: LAYOUT_KIND.ExecSummary, actionTitle: "MARICO held 9.1% category share despite a 12% category decline in Q3",
      speakerNotes: "Three takeaways: share held, premium mix grew, trade spend needs reallocation.",
      slots: { bullets: [
        "Net sales fell 12% to ₫61B in Q3, driven entirely by a category-wide volume decline rather than share loss.",
        "MARICO held 9.1% value share within female shower gel, up 0.4pp versus Q2 even as the category shrank.",
        "Premium SKUs grew 8% and now contribute 34% of MARICO value, cushioning the volume softness.",
        "Trade spend is concentrated in declining mass SKUs; reallocating 18% to premium would protect Q4 share.",
      ] } },
    { layout: LAYOUT_KIND.KpiRow, actionTitle: "Four metrics frame the Q3 story for MARICO Vietnam",
      speakerNotes: "KPI tiles summarising the quarter at a glance.",
      slots: { kpis: [
        { label: "Net sales (Q3)", value: "₫61.0B", delta: "−12% vs Q2", confidence: "high" },
        { label: "Category value share", value: "9.1%", delta: "+0.4pp vs Q2", confidence: "high" },
        { label: "Premium mix", value: "34%", delta: "+3.0pp vs Q2", confidence: "medium" },
        { label: "Distribution", value: "2,680", delta: "+6% stores", confidence: "medium" },
      ] } },
    { layout: LAYOUT_KIND.ChartWithInsight, actionTitle: "Parachute drove 58% of Q3 net sales but slipped 18% on the quarter",
      speakerNotes: "Grouped bar of net sales by brand across quarters. Call out Parachute's Q3 dip.",
      slots: { chartId: "s0c0", insight: "Parachute remains the volume engine, but its Q3 decline is the single biggest drag on category value.", source: "Source: Nielsen scan, Q3 2025; n=2,341 stores" } },
    { layout: LAYOUT_KIND.TableSlide, actionTitle: "Three SKUs account for 82% of MARICO Q3 value",
      speakerNotes: "Top SKU table by units, value, and share.",
      slots: { caption: "Top SKUs by Q3 value", insight: "The top three SKUs concentrate the portfolio — premium Saffola Gold is the fastest riser.",
        tableRef: { kind: "ref", tableId: "s0t0" } } },
    { layout: LAYOUT_KIND.ImplicationsByHorizon, actionTitle: "Q3 results imply three moves across now, this quarter, and strategic horizons",
      speakerNotes: "Implications grouped by horizon.",
      slots: {
        now: ["Protect Parachute shelf presence in top 500 stores before festive peak.", "Hold price on premium SKUs; the volume softness is category-wide, not pricing-driven."],
        thisQuarter: ["Reallocate 18% of trade spend from mass to premium SKUs.", "Expand distribution of Saffola Gold to the 1,200 stores currently stocking only mass SKUs."],
        strategic: ["Build a premium-led portfolio to decouple MARICO growth from the declining mass category."] } },
    { layout: LAYOUT_KIND.Recommendations, actionTitle: "Four prioritised actions protect Q4 share and accelerate premium",
      speakerNotes: "Numbered recommendations with horizon and confidence.",
      slots: { items: [
        { action: "Reallocate 18% of trade spend to premium SKUs", rationale: "Premium grew 8% while mass declined; spend is currently mis-weighted toward the shrinking segment.", horizon: "this_quarter", confidence: "high", owner: "Trade Marketing" },
        { action: "Protect Parachute distribution in top 500 stores", rationale: "Parachute's Q3 dip is the biggest single drag; defending its core doors limits further category-value erosion.", horizon: "now", confidence: "high", owner: "Sales" },
        { action: "Expand Saffola Gold to 1,200 mass-only stores", rationale: "The fastest-rising SKU is under-distributed relative to its velocity.", horizon: "this_quarter", confidence: "medium", owner: "Distribution" },
        { action: "Build a premium-led 3-year portfolio roadmap", rationale: "Structural category decline makes premium mix the durable growth lever.", horizon: "strategic", confidence: "medium", owner: "Brand" },
      ] } },
    { layout: LAYOUT_KIND.Methodology, actionTitle: "Methodology · 13 weeks of Nielsen scan across 2,341 stores",
      speakerNotes: "Methodology and caveats.",
      slots: { body: "Analysis is based on 13 weeks of Nielsen retail-scan data covering 2,341 stores across Vietnam's modern and general trade channels, from July to September 2025. Net sales are value-based (₫) at retail selling price. Category is defined as female shower gel, 200ml-equivalent. Share is value share within the defined category. Premium is defined as SKUs priced above the category median. All quarter-over-quarter comparisons are versus the equivalent 13-week Q2 window.",
        caveats: ["General-trade coverage is modelled, not census; small-store estimates carry ±3% error.", "Promotional value is included in net sales and not separately deflated.", "September data is preliminary and subject to a one-week restatement."] } },
    { layout: LAYOUT_KIND.Appendix, actionTitle: "Appendix · category share detail by brand",
      speakerNotes: "Supporting pie chart of category share.",
      slots: { chartId: "s0c1", body: "" } },
  ],
};

import { mkdirSync } from "node:fs";
mkdirSync("/tmp/decks", { recursive: true });

const buf = await renderDeckPlanToPptxBuffer(plan, dashboard);
writeFileSync("/tmp/decks/full.pptx", buf);
console.log(`wrote full.pptx (${buf.length} bytes, ${plan.slides.length} slides)`);

// One 1-slide deck per layout so qlmanage (slide-1 only) can show every slide.
for (let i = 0; i < plan.slides.length; i++) {
  const s = plan.slides[i]!;
  const one = { ...plan, slides: [s] } as SlideDeckPlan;
  const b = await renderDeckPlanToPptxBuffer(one, dashboard);
  const name = `slide${String(i).padStart(2, "0")}_${s.layout}`;
  writeFileSync(`/tmp/decks/${name}.pptx`, b);
  console.log(`  ${name}.pptx (${b.length}b)`);
}
