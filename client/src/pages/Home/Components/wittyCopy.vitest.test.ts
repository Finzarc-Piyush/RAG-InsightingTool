/**
 * Pin the shared witty-copy pool: every pipeline stage must resolve to a
 * NON-EMPTY bank (so no stage silently degrades to the generic fallback), and
 * the deterministic picker must be stable per seed yet spread across seeds.
 */
import { describe, it, expect } from "vitest";
import type { EnrichmentStep } from "@/lib/api/uploadStatus";
import {
  WITTY_POOLS,
  categoryForThinkingStep,
  categoryForEnrichmentStep,
  wittyPoolFor,
  pickWittyLine,
  type WittyCategory,
} from "./wittyCopy";

// Every server thinking-step key the agent loop / chat stream can emit.
const THINKING_STEP_KEYS = [
  "Mapping columns from schema",
  "Analyzing user intent",
  "Detecting query type",
  "Loading dataset",
  "Generating hypotheses",
  "Drafting analysis brief & hypotheses",
  "Running investigation pre-planner",
  "Retrieving session context",
  "Agent plan",
  "Planning approach",
  "Synthesizing answer",
  "Reviewing answer",
  "Building dashboard",
  "Running tool: duckdbQuery",
];

const ENRICHMENT_STEPS: EnrichmentStep[] = [
  "inferring_profile",
  "dirty_date_enrichment",
  "building_context",
  "persisting",
];

describe("wittyCopy · pool coverage", () => {
  it("every category bank is non-empty", () => {
    for (const [cat, pool] of Object.entries(WITTY_POOLS)) {
      expect(pool.length, `${cat} bank`).toBeGreaterThan(0);
    }
  });

  it("the combined pool is large (≥ 500 lines)", () => {
    const total = Object.values(WITTY_POOLS).reduce((n, p) => n + p.length, 0);
    expect(total).toBeGreaterThanOrEqual(500);
  });

  it("every thinking step key resolves to a non-empty, non-generic-by-accident bank", () => {
    for (const step of THINKING_STEP_KEYS) {
      const cat = categoryForThinkingStep(step);
      // None of the known steps should fall through to `generic`.
      expect(cat, `${step} → category`).not.toBe("generic");
      expect(wittyPoolFor(cat).length, `${step} bank`).toBeGreaterThan(0);
    }
  });

  it("unknown steps fall back to generic (and generic is non-empty)", () => {
    expect(categoryForThinkingStep("Some future step")).toBe("generic");
    expect(wittyPoolFor("generic").length).toBeGreaterThan(0);
  });

  it("every enrichment step resolves to a dedicated non-empty bank", () => {
    for (const step of ENRICHMENT_STEPS) {
      const cat = categoryForEnrichmentStep(step);
      expect(cat, `${step} → category`).not.toBe("generic");
      expect(wittyPoolFor(cat).length, `${step} bank`).toBeGreaterThan(0);
    }
  });

  it("all lines are trimmed, non-empty strings", () => {
    for (const [cat, pool] of Object.entries(WITTY_POOLS)) {
      for (const line of pool) {
        expect(line.length, `${cat} line`).toBeGreaterThan(0);
        expect(line).toBe(line.trim());
      }
    }
  });
});

describe("wittyCopy · pickWittyLine determinism", () => {
  const cats = Object.keys(WITTY_POOLS) as WittyCategory[];

  it("always returns a line from the category bank", () => {
    for (const cat of cats) {
      for (let seed = 0; seed < 200; seed++) {
        expect(wittyPoolFor(cat)).toContain(pickWittyLine(cat, seed));
      }
    }
  });

  it("is stable for a given (category, seed)", () => {
    const seed = 1_718_000_000_123;
    expect(pickWittyLine("planning", seed)).toBe(pickWittyLine("planning", seed));
    expect(pickWittyLine("columns", 42)).toBe(pickWittyLine("columns", 42));
  });

  it("spreads across seeds (not a constant)", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 300; seed++) {
      seen.add(pickWittyLine("synthesis", seed * 7919 + 13));
    }
    // A healthy hash should surface many distinct lines from the bank.
    expect(seen.size).toBeGreaterThan(5);
  });
});
