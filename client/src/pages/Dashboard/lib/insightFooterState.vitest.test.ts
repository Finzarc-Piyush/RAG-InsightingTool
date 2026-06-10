import { describe, expect, it } from "vitest";
import { resolveInsightFooterMode, pickFooterText } from "./insightFooterState";

describe("Wave Z3 · resolveInsightFooterMode", () => {
  it("is 'present' when a static insight exists", () => {
    expect(resolveInsightFooterMode("Cluster 2 WEST lags.", undefined, false)).toBe("present");
  });

  it("is 'present' when a fresh regen entry exists (even without static insight)", () => {
    expect(resolveInsightFooterMode(undefined, "regenerated text", false)).toBe("present");
  });

  it("is 'loading' when regenerating and nothing to show yet", () => {
    expect(resolveInsightFooterMode(undefined, undefined, true)).toBe("loading");
    expect(resolveInsightFooterMode("   ", "  ", true)).toBe("loading");
  });

  it("is 'empty' when there is no insight and nothing in flight", () => {
    expect(resolveInsightFooterMode(undefined, undefined, false)).toBe("empty");
    expect(resolveInsightFooterMode("", "", false)).toBe("empty");
  });
});

describe("Wave Z3 · pickFooterText", () => {
  it("prefers a fresh regen entry over the static insight", () => {
    expect(pickFooterText("fresh", "static")).toBe("fresh");
  });

  it("falls back to the static insight when no entry text", () => {
    expect(pickFooterText(undefined, "static")).toBe("static");
    expect(pickFooterText("  ", "static")).toBe("static");
  });

  it("returns empty string when neither is present", () => {
    expect(pickFooterText(undefined, undefined)).toBe("");
  });
});
