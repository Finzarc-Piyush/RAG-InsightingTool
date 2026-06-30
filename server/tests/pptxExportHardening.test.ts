/**
 * Stream A+B · end-to-end hardening of the PPTX export:
 *   - corrupt-data charts (NaN/Infinity/null) never leak a non-finite literal
 *     into the chart XML or the embedded workbook (the "Repair" prompt cause);
 *   - a single-point line chart is downgraded to a bar (no meaningless lone dot);
 *   - a long 3-lane insight renders as structured "Why:"/"Do:" runs (the fix for
 *     insight text spilling onto the chart / off the slide);
 *   - a degenerate (all-zero) chart degrades to a visible placeholder, not a
 *     blank card;
 *   - no slide shape extends below the slide;
 *   - empty-label magnitudes never become bare KPI tiles.
 *
 * Drives the real `buildDashboardDeckPptx` pipeline with the planner stubbed to
 * fail (so the deterministic fallback runs — the exact path the user hit), then
 * unzips the .pptx and inspects the parts.
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  buildDashboardDeckPptx,
  buildFallbackDeckPlan,
} from "../lib/exports/buildDashboardDeck.js";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { Dashboard, ChartSpec } from "../shared/schema.js";

/** Planner stub that yields a schema-invalid plan → `null` → fallback path. */
function stubPlannerToFail(): void {
  installLlmStub({ [LLM_PURPOSE.DECK_PLANNER]: () => ({ slides: [] }) });
}

function dashboardWith(charts: ChartSpec[], envelope?: Dashboard["answerEnvelope"]): Dashboard {
  return {
    id: "dash-hardening",
    username: "tester@marico",
    name: "Finance Dashboard",
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    charts: [],
    sheets: [{ id: "s0", name: "Overview", order: 0, charts }],
    answerEnvelope: envelope,
  } as Dashboard;
}

async function loadZip(buf: Buffer) {
  const JSZip = (await import("jszip")).default;
  return JSZip.loadAsync(buf);
}

function isZip(buf: Buffer): boolean {
  return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

async function chartXml(buf: Buffer): Promise<string> {
  const zip = await loadZip(buf);
  const parts = Object.keys(zip.files).filter((n) => /^ppt\/charts\/.*\.xml$/.test(n));
  const texts = await Promise.all(parts.map((n) => zip.files[n]!.async("string")));
  return texts.join("\n");
}

async function slideXml(buf: Buffer): Promise<string> {
  const zip = await loadZip(buf);
  const parts = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const texts = await Promise.all(parts.map((n) => zip.files[n]!.async("string")));
  return texts.join("\n");
}

/** Concatenate every chart XML part AND every embedded-workbook XML part. */
async function chartAndEmbedXml(buf: Buffer): Promise<string> {
  const zip = await loadZip(buf);
  const out: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/charts\/.*\.xml$/.test(name)) out.push(await zip.files[name]!.async("string"));
    if (/^ppt\/embeddings\/.*\.xlsx$/.test(name)) {
      const inner = await loadZip(await zip.files[name]!.async("nodebuffer"));
      for (const f of Object.keys(inner.files)) {
        if (/\.xml$/.test(f)) out.push(await inner.files[f]!.async("string"));
      }
    }
  }
  return out.join("\n");
}

/** True when no shape's (y + height) exceeds the slide height (7.5in in EMU). */
function allShapesWithinSlide(xml: string): boolean {
  const SLIDE_H_EMU = 6_858_000;
  const TOL = 12_000;
  const offs = [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/g)];
  const exts = [...xml.matchAll(/<a:ext cx="(\d+)" cy="(\d+)"\/>/g)];
  const n = Math.min(offs.length, exts.length);
  for (let i = 0; i < n; i++) {
    const y = Number(offs[i]![2]);
    const cy = Number(exts[i]![2]);
    if (y + cy > SLIDE_H_EMU + TOL) return false;
  }
  return true;
}

describe("PPTX export hardening", () => {
  afterEach(() => clearLlmStub());

  it("never leaks NaN/Infinity into chart XML or the embedded workbook", async () => {
    stubPlannerToFail();
    const nasty: ChartSpec = {
      type: "bar",
      title: "Revenue by channel",
      x: "Channel",
      y: "NR",
      data: [
        { Channel: "GT", NR: 470 },
        { Channel: "MT", NR: NaN },
        { Channel: "CSD", NR: Infinity },
        { Channel: "EC", NR: -Infinity },
        { Channel: "QC", NR: null },
      ],
    } as unknown as ChartSpec;
    const buf = await buildDashboardDeckPptx(dashboardWith([nasty]));
    assert.ok(isZip(buf), "must be a valid ZIP");
    const xml = await chartAndEmbedXml(buf);
    assert.ok(!/NaN/.test(xml), "no NaN literal in chart/embedding XML");
    assert.ok(!/Infinity/.test(xml), "no Infinity literal in chart/embedding XML");
  });

  it("downgrades a single-point line chart to a bar (no lone dot)", async () => {
    stubPlannerToFail();
    const single: ChartSpec = {
      type: "line",
      title: "NR by Month",
      x: "Month",
      y: "NR",
      data: [{ Month: "2025-04", NR: 678 }],
    } as unknown as ChartSpec;
    const buf = await buildDashboardDeckPptx(dashboardWith([single]));
    const xml = await chartXml(buf);
    assert.ok(/<c:barChart>/.test(xml), "single-point series should render as a bar");
    assert.ok(!/<c:lineChart>/.test(xml), "no lineChart for a single point");
  });

  it("renders a long 3-lane insight as structured Why:/Do: runs", async () => {
    stubPlannerToFail();
    const headline =
      "GT contributes 470.92 of 677.86 total NR, making it the single largest revenue pool by a wide margin.";
    const why = "general-trade route-to-market carries far more volume than the smaller digital channels.";
    const doLane = "anchor the channel dashboard on GT and treat the digital channels as small-channel watchouts.";
    const charted: ChartSpec = {
      type: "bar",
      title: "NR by channel",
      x: "Channel",
      y: "NR",
      data: [
        { Channel: "GT", NR: 470 },
        { Channel: "MT", NR: 107 },
      ],
      keyInsight: `${headline} WHY: ${why} DO: ${doLane}`,
    } as unknown as ChartSpec;
    const buf = await buildDashboardDeckPptx(dashboardWith([charted]));
    const xml = await slideXml(buf);
    assert.ok(/Why:/.test(xml), "WHY lane rendered as a 'Why:' run");
    assert.ok(/Do:/.test(xml), "DO lane rendered as a 'Do:' run");
    assert.ok(allShapesWithinSlide(xml), "no shape extends below the slide");
  });

  it("bails the native renderer for an all-zero chart (no corrupt native part)", async () => {
    stubPlannerToFail();
    const allZero: ChartSpec = {
      type: "bar",
      title: "Empty metric",
      x: "Channel",
      y: "NR",
      data: [
        { Channel: "GT", NR: 0 },
        { Channel: "MT", NR: 0 },
      ],
    } as unknown as ChartSpec;
    const buf = await buildDashboardDeckPptx(dashboardWith([allZero]));
    assert.ok(isZip(buf), "still a valid ZIP");
    // The degenerate guard makes native bail (so it can't emit a corrupt all-zero
    // chart part); the SVG path renders a safe image instead, so there is no
    // native <c:barChart> for this deck.
    const xml = await chartXml(buf);
    assert.ok(!/<c:barChart>/.test(xml), "native bar chart should NOT be emitted for an all-zero chart");
  });

  it("does not turn empty-label magnitudes into bare KPI tiles", () => {
    const blankLabels = buildFallbackDeckPlan(
      dashboardWith(
        [{ type: "bar", title: "c", x: "a", y: "b", data: [{ a: "x", b: 1 }] } as unknown as ChartSpec],
        {
          tldr: "Net revenue is concentrated in general trade.",
          magnitudes: [
            { label: "", value: "470.92" },
            { label: "   ", value: "257.02" },
            { label: "", value: "677.86" },
          ],
        } as Dashboard["answerEnvelope"]
      ),
      { generatedAt: "2026-06-30" }
    );
    assert.ok(
      !blankLabels.slides.some((s) => s.layout === "KpiRow"),
      "all-blank-label magnitudes must NOT produce a KpiRow"
    );

    const goodLabels = buildFallbackDeckPlan(
      dashboardWith(
        [{ type: "bar", title: "c", x: "a", y: "b", data: [{ a: "x", b: 1 }] } as unknown as ChartSpec],
        {
          tldr: "Net revenue is concentrated in general trade.",
          magnitudes: [
            { label: "Total NR", value: "677.86" },
            { label: "Top brand NR", value: "257.02" },
          ],
        } as Dashboard["answerEnvelope"]
      ),
      { generatedAt: "2026-06-30" }
    );
    assert.ok(
      goodLabels.slides.some((s) => s.layout === "KpiRow"),
      "labelled magnitudes should still produce a KpiRow"
    );
  });
});
