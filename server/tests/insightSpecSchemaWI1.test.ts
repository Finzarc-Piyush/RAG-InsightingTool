import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  insightSpecSchema,
  legacyKeyInsightToInsightSpec,
  chartSpecSchema,
  type InsightSpec,
} from "../shared/schema.js";

describe("WI1 · insightSpecSchema — round-trip + bounds", () => {
  it("parses a minimal spec with just `default`", () => {
    const parsed = insightSpecSchema.parse({
      default: "Parachute leads the coconut-oil category by 12 pp.",
    });
    assert.equal(parsed.default, "Parachute leads the coconut-oil category by 12 pp.");
    assert.equal(parsed.generator, undefined);
  });

  it("round-trips a fully-populated spec", () => {
    const input: InsightSpec = {
      default: "Q3 volume dropped 8% vs prior quarter, driven by North + East.",
      generator: {
        kind: "llm",
        args: { promptKey: "explain-this-view", contextRefs: ["tile-12"] },
      },
      confidenceTier: "high",
      citations: ["kpi-and-metric-glossary", "marico-haircare-portfolio"],
      regeneratedAt: "2026-05-16T10:30:00Z",
    };
    const parsed = insightSpecSchema.parse(input);
    assert.deepEqual(parsed, input);
  });

  it("enforces 500-char cap on default text", () => {
    assert.throws(() =>
      insightSpecSchema.parse({ default: "x".repeat(501) }),
    );
  });

  it("accepts generator.kind in {'llm', 'deterministic'}", () => {
    for (const kind of ["llm", "deterministic"] as const) {
      const parsed = insightSpecSchema.parse({
        default: "test",
        generator: { kind },
      });
      assert.equal(parsed.generator?.kind, kind);
    }
  });

  it("rejects unknown generator kinds", () => {
    assert.throws(() =>
      insightSpecSchema.parse({
        default: "test",
        generator: { kind: "magic" as never },
      }),
    );
  });

  it("citations cap is 8 entries", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => `pack-${i}`);
    assert.throws(() =>
      insightSpecSchema.parse({ default: "x", citations: tooMany }),
    );
  });

  it("rejects empty-string citation entries (must be non-empty)", () => {
    assert.throws(() =>
      insightSpecSchema.parse({ default: "x", citations: [""] }),
    );
  });

  it("accepts opaque generator.args via passthrough record", () => {
    const parsed = insightSpecSchema.parse({
      default: "test",
      generator: {
        kind: "llm",
        args: {
          nested: { deeper: { thing: 42 } },
          listOfStuff: [1, 2, "three"],
          maybeNull: null,
        },
      },
    });
    assert.deepEqual(parsed.generator?.args, {
      nested: { deeper: { thing: 42 } },
      listOfStuff: [1, 2, "three"],
      maybeNull: null,
    });
  });
});

describe("WI1 · legacyKeyInsightToInsightSpec — back-compat migration", () => {
  it("lifts a plain string into a default-only spec", () => {
    const out = legacyKeyInsightToInsightSpec("Sales grew 12% in Q3.");
    assert.deepEqual(out, { default: "Sales grew 12% in Q3." });
  });

  it("returns undefined for empty / whitespace-only / undefined inputs", () => {
    assert.equal(legacyKeyInsightToInsightSpec(undefined), undefined);
    assert.equal(legacyKeyInsightToInsightSpec(""), undefined);
    assert.equal(legacyKeyInsightToInsightSpec("   "), undefined);
  });

  it("trims and truncates to the 500-char default cap", () => {
    const big = "x".repeat(800);
    const out = legacyKeyInsightToInsightSpec(big);
    assert.equal(out?.default.length, 500);
  });
});

describe("WI1 · chartSpec coexistence — keyInsight and insight both optional", () => {
  function baseChart() {
    return {
      type: "bar" as const,
      title: "Sales by Region",
      x: "Region",
      y: "Sales",
    };
  }

  it("accepts a chart with only legacy keyInsight (pre-WI1 charts unchanged)", () => {
    const parsed = chartSpecSchema.parse({
      ...baseChart(),
      keyInsight: "MARICO leads.",
    });
    assert.equal(parsed.keyInsight, "MARICO leads.");
    assert.equal(parsed.insight, undefined);
  });

  it("accepts a chart with only the WI1 insight", () => {
    const parsed = chartSpecSchema.parse({
      ...baseChart(),
      insight: {
        default: "MARICO leads.",
        confidenceTier: "high",
      },
    });
    assert.equal(parsed.insight?.default, "MARICO leads.");
    assert.equal(parsed.keyInsight, undefined);
  });

  it("accepts a chart with both fields populated (renderer picks one, but both parse cleanly)", () => {
    const parsed = chartSpecSchema.parse({
      ...baseChart(),
      keyInsight: "Legacy text",
      insight: { default: "Richer text", confidenceTier: "medium" },
    });
    assert.equal(parsed.keyInsight, "Legacy text");
    assert.equal(parsed.insight?.default, "Richer text");
  });
});
