import { describe, it, expect } from "vitest";
import {
  flattenSummaryCards,
  buildSummaryLayouts,
  summaryCardGridId,
  SUMMARY_TILE_CONFIG,
} from "./summaryGridLayout";
import type { DashboardAnswerEnvelope } from "@/shared/schema";

const envelope = (): DashboardAnswerEnvelope =>
  ({
    magnitudes: [
      { label: "GT · NR", value: "470.92", tone: "green", id: "mag_1" },
      { label: "PCNO · NR", value: "257.02", tone: "amber", id: "mag_2" },
    ],
    findings: [{ headline: "GT dominant", evidence: "470 of 677", id: "find_1" }],
  }) as DashboardAnswerEnvelope;

const areas = [
  {
    dimension: "Brand",
    unit: "NHR_SRSOH",
    metric: "NR by P3 Brand",
    value: 0,
    benchmark: 1,
    variancePct: -103,
    status: "amber" as const,
    id: "attn_1",
  },
];

describe("summaryGridLayout · flatten", () => {
  it("flattens all groups in order with stable grid ids", () => {
    const cards = flattenSummaryCards(envelope(), areas);
    // Order: magnitudes, attentionAreas, findings, …
    expect(cards.map((c) => c.gridId)).toEqual(["mag_1", "mag_2", "attn_1", "find_1"]);
    expect(cards.map((c) => c.group)).toEqual([
      "magnitudes",
      "magnitudes",
      "attentionAreas",
      "findings",
    ]);
    expect(cards[2].index).toBe(0); // index is within the group's own array
  });

  it("falls back to a group-index id when a card has no id", () => {
    expect(summaryCardGridId("magnitudes", { label: "x", value: "1" }, 3)).toBe("magnitudes-3");
    expect(summaryCardGridId("findings", { id: "find_9" }, 0)).toBe("find_9");
  });
});

describe("summaryGridLayout · buildSummaryLayouts", () => {
  it("auto-places every card across all breakpoints when nothing is saved", () => {
    const cards = flattenSummaryCards(envelope(), areas);
    const layouts = buildSummaryLayouts(cards, null);
    for (const bp of ["lg", "md", "sm", "xs", "xxs"]) {
      expect(layouts[bp]).toHaveLength(cards.length);
      // every card present, ids intact
      expect(new Set(layouts[bp].map((l) => l.i))).toEqual(
        new Set(cards.map((c) => c.gridId)),
      );
    }
  });

  it("respects saved positions and packs only the new cards", () => {
    const cards = flattenSummaryCards(envelope(), areas);
    const saved = {
      lg: [{ i: "mag_1", x: 5, y: 9, w: 3, h: 3 }],
    };
    const layouts = buildSummaryLayouts(cards, saved);
    const mag1 = layouts.lg.find((l) => l.i === "mag_1")!;
    expect(mag1.x).toBe(5);
    expect(mag1.y).toBe(9);
    // The unsaved cards are packed BELOW the saved block (y >= 9+3).
    for (const l of layouts.lg) {
      if (l.i !== "mag_1") expect(l.y).toBeGreaterThanOrEqual(12);
    }
  });

  it("clamps a saved card's width into a narrow breakpoint", () => {
    const cards = flattenSummaryCards(envelope(), areas);
    const saved = { xxs: [{ i: "mag_1", x: 0, y: 0, w: 8, h: 3 }] };
    const layouts = buildSummaryLayouts(cards, saved);
    const mag1 = layouts.xxs.find((l) => l.i === "mag_1")!;
    expect(mag1.w).toBeLessThanOrEqual(2); // xxs has 2 cols
    expect(mag1.w).toBeGreaterThanOrEqual(SUMMARY_TILE_CONFIG.magnitudes.minW);
  });
});
