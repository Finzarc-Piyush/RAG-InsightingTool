import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectUnsupportedCausalClaims,
  sanitizeLikelyDrivers,
} from "../lib/agents/runtime/verifierCausalCheck.js";
import { buildIdentityGraph } from "../lib/financeMetricAuthority.js";
import type { LikelyDriver } from "../shared/schema/charts.js";

const COLUMNS = ["Channel", "GC", "Net Revenue", "COGS", "GC%", "A&P Spend"];
const graph = buildIdentityGraph({ columns: COLUMNS });

/**
 * W10 · the NO_STRUCTURAL_IDENTITY rail. A relational claim between two
 * definitionally-linked metrics (GC% ↔ NR) is a tautology → blocked. A genuine
 * DECOMPOSITION between structurally-related metrics (RM/COGS → GC%) is the
 * exact case we must NOT suppress. A relationship between unrelated metrics is
 * untouched.
 */
describe("detectUnsupportedCausalClaims — NO_STRUCTURAL_IDENTITY", () => {
  it("BLOCKS 'GC% is impacted by Net Revenue' (tautology)", () => {
    const out = detectUnsupportedCausalClaims(
      { findings: [{ headline: "GC% is impacted by Net Revenue", evidence: "", magnitude: "" }] } as any,
      COLUMNS,
      graph,
    );
    assert.equal(out.structuralIdentityClaims.length, 1);
    assert.ok(out.flags.some((f) => f.kind === "structural_identity_claim" && f.severity === "block"));
    assert.equal(out.shouldRevise, true);
  });

  it("EXEMPTS a decomposition: 'rising COGS compressed GC% by 3 pts'", () => {
    const out = detectUnsupportedCausalClaims(
      { findings: [{ headline: "Rising COGS compressed GC% by 3 pts this quarter", evidence: "", magnitude: "" }] } as any,
      COLUMNS,
      graph,
    );
    assert.equal(out.structuralIdentityClaims.length, 0);
  });

  it("does NOT block a relationship between unrelated metrics (A&P ↔ Net Revenue)", () => {
    const out = detectUnsupportedCausalClaims(
      { likelyDrivers: [{ explanation: "A&P Spend may be associated with Net Revenue", basis: "general", confidence: "low" }] } as any,
      COLUMNS,
      graph,
    );
    assert.equal(out.structuralIdentityClaims.length, 0);
  });

  it("is a no-op without an identity graph (back-compat)", () => {
    const out = detectUnsupportedCausalClaims(
      { findings: [{ headline: "GC% is impacted by Net Revenue", evidence: "", magnitude: "" }] } as any,
      COLUMNS,
    );
    assert.equal(out.structuralIdentityClaims.length, 0);
  });
});

describe("sanitizeLikelyDrivers — drops identity-as-cause, keeps decomposition", () => {
  const drivers: LikelyDriver[] = [
    { explanation: "GC% is likely driven by Net Revenue", basis: "general", confidence: "low" },
    { explanation: "likely that rising COGS compressed GC% (a decomposition of the margin move)", basis: "general", confidence: "low" },
    { explanation: "A&P Spend may be associated with higher volume", basis: "general", confidence: "low" },
  ];

  it("drops the tautology, keeps the decomposition and the unrelated driver", () => {
    const out = sanitizeLikelyDrivers(drivers, COLUMNS, graph);
    const texts = out.map((d) => d.explanation);
    assert.ok(!texts.some((t) => /GC% is likely driven by Net Revenue/.test(t)));
    assert.ok(texts.some((t) => /compressed GC%/.test(t)));
    assert.ok(texts.some((t) => /A&P Spend/.test(t)));
    assert.equal(out.length, 2);
  });
});
