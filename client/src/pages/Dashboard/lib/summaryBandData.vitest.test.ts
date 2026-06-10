import { describe, expect, it } from "vitest";
import {
  hasSummaryBandContent,
  selectSummaryBandData,
  selectAttentionAreas,
} from "./summaryBandData";
import type { AttentionAreaSpec, DashboardAnswerEnvelope } from "@/shared/schema";

const envelope: DashboardAnswerEnvelope = {
  tldr: "  PJP adherence is 21% in April 2026, concentrated in a few clusters.  ",
  magnitudes: [
    { label: "PJP adherence", value: "21.0%", confidence: "high" },
    { label: "", value: "skip-me" },
    { label: "Matching rows", value: "2.1K of 10K" },
  ],
  findings: [
    { headline: "Cluster 2 WEST lags", evidence: "16% vs 26% leader", magnitude: "16%" },
    { headline: "TSOE vacancy → 0% adherence", evidence: "..." },
    { headline: "Early clock-in correlates", evidence: "..." },
    { headline: "Android beats iOS", evidence: "..." },
  ],
};

describe("Wave ES1 · hasSummaryBandContent", () => {
  it("is true when any of tldr / magnitudes / findings is present", () => {
    expect(hasSummaryBandContent(envelope)).toBe(true);
    expect(hasSummaryBandContent({ tldr: "x" })).toBe(true);
    expect(hasSummaryBandContent({ magnitudes: [{ label: "a", value: "1" }] })).toBe(true);
  });

  it("is false for empty / undefined envelopes", () => {
    expect(hasSummaryBandContent(undefined)).toBe(false);
    expect(hasSummaryBandContent({})).toBe(false);
    expect(hasSummaryBandContent({ tldr: "   " })).toBe(false);
  });
});

describe("Wave ES1 · selectSummaryBandData", () => {
  it("trims the tldr and drops invalid magnitudes", () => {
    const data = selectSummaryBandData(envelope);
    expect(data.tldr).toBe("PJP adherence is 21% in April 2026, concentrated in a few clusters.");
    // The blank-label magnitude is dropped.
    expect(data.magnitudes.map((m) => m.label)).toEqual(["PJP adherence", "Matching rows"]);
    expect(data.magnitudes[0].confidence).toBe("high");
  });

  it("caps findings to maxFindings and carries the magnitude pill", () => {
    const data = selectSummaryBandData(envelope, 3);
    expect(data.findings).toHaveLength(3);
    expect(data.findings[0]).toEqual({ headline: "Cluster 2 WEST lags", magnitude: "16%" });
    expect(data.findings[1].magnitude).toBeUndefined();
  });

  it("returns empty structures for an empty envelope", () => {
    const data = selectSummaryBandData({});
    expect(data).toEqual({ tldr: null, magnitudes: [], findings: [] });
  });
});

describe("MW4 · selectAttentionAreas", () => {
  const areas: AttentionAreaSpec[] = [
    {
      dimension: "ASM",
      unit: "Bihar West",
      metric: "PJP Adherence rate by ASM",
      value: 0.41,
      benchmark: 0.6,
      variancePct: -31.7,
      status: "red",
    },
    {
      dimension: "Cluster Name",
      unit: "Cluster 2 WEST",
      metric: "Compliance rate by Cluster Name",
      value: 0.55,
      benchmark: 0.6,
      variancePct: -8.3,
      status: "amber",
    },
  ];

  it("formats a manager-readable below-avg delta and carries status", () => {
    const out = selectAttentionAreas(areas);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      unit: "Bihar West",
      dimension: "ASM",
      metric: "PJP Adherence rate by ASM",
      deltaLabel: "32% below avg",
      status: "red",
    });
    expect(out[1].deltaLabel).toBe("8% below avg");
    expect(out[1].status).toBe("amber");
  });

  it("is empty/no-op for undefined or blank-unit input", () => {
    expect(selectAttentionAreas(undefined)).toEqual([]);
    expect(selectAttentionAreas([{ ...areas[0], unit: "   " }])).toEqual([]);
  });
});
