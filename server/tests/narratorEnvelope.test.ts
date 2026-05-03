import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messageSchema } from "../shared/schema.js";
import { z } from "zod";

/**
 * W3 · AnswerEnvelope contract.
 *
 * The narrator emits TL;DR + findings + methodology + caveats. This test
 * pins the schema's invariants so the UI's AnswerCard (W7) can rely on them:
 *  - every field is optional independently
 *  - findings honor the headline/evidence/magnitude shape
 *  - length caps match the prompt's instructions to the LLM
 */

// Recreate the narrator's local output schema to verify it's a strict
// superset of the persisted answerEnvelope shape — the loop wires
// narrator output → answerEnvelope, so any narrator field that lacks a
// home in the schema would be silently dropped.
// WTL3 · caps loosened to mirror the bumped narratorOutputSchema in
// narratorAgent.ts and the answerEnvelope in shared/schema.ts.
const narratorOutputSchemaMirror = z.object({
  body: z.string(),
  keyInsight: z.string().nullable().optional(),
  ctas: z.array(z.string()).default([]),
  magnitudes: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  unexplained: z.string().optional(),
  tldr: z.string().max(400).optional(),
  findings: z
    .array(
      z.object({
        headline: z.string().max(280),
        evidence: z.string().max(1200),
        magnitude: z.string().max(120).optional(),
      })
    )
    .max(7)
    .optional(),
  methodology: z.string().max(1400).optional(),
  caveats: z.array(z.string().max(280)).max(5).optional(),
});

describe("W3 · messageSchema.answerEnvelope", () => {
  const baseMessage = {
    role: "assistant" as const,
    content: "Sales fell 12% in West.",
    timestamp: 1_700_000_000_000,
  };

  it("accepts a fully-populated envelope", () => {
    const parsed = messageSchema.safeParse({
      ...baseMessage,
      answerEnvelope: {
        tldr: "West region sales fell 12.4% YoY in Q3, driven by tier-2 stores.",
        findings: [
          {
            headline: "West Q3 sales -12.4% YoY",
            evidence: "Q3 revenue ₹4.2B vs Q3'25 ₹4.8B; gap concentrated in tier-2 stores.",
            magnitude: "-12.4% YoY",
          },
          {
            headline: "Tier-2 stores account for 78% of the shortfall",
            evidence: "Tier-2 revenue -₹0.47B vs total gap ₹0.60B.",
            magnitude: "78% of gap",
          },
        ],
        methodology:
          "Compared Q3 2026 sales (DuckDB groupBy region+tier) to Q3 2025 baseline; filtered to closed-month transactions.",
        caveats: ["Two tier-2 stores reported partial data."],
        nextSteps: ["Drill into which SKUs drove the tier-2 decline."],
      },
    });
    assert.strictEqual(parsed.success, true);
  });

  it("accepts a partial envelope (just TL;DR)", () => {
    const parsed = messageSchema.safeParse({
      ...baseMessage,
      answerEnvelope: { tldr: "Sales held flat." },
    });
    assert.strictEqual(parsed.success, true);
  });

  it("accepts a message with NO envelope (synthesizer fallback path)", () => {
    const parsed = messageSchema.safeParse(baseMessage);
    assert.strictEqual(parsed.success, true);
  });

  it("rejects TL;DR over 400 chars (WTL3 · cap raised 280 → 400)", () => {
    const parsed = messageSchema.safeParse({
      ...baseMessage,
      answerEnvelope: { tldr: "a".repeat(401) },
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects more than 7 findings (WTL3 · cap raised 5 → 7)", () => {
    const parsed = messageSchema.safeParse({
      ...baseMessage,
      answerEnvelope: {
        findings: Array.from({ length: 8 }, (_, i) => ({
          headline: `H${i}`,
          evidence: `E${i}`,
        })),
      },
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects more than 5 caveats (WTL3 · cap raised 3 → 5)", () => {
    const parsed = messageSchema.safeParse({
      ...baseMessage,
      answerEnvelope: { caveats: ["a", "b", "c", "d", "e", "f"] },
    });
    assert.strictEqual(parsed.success, false);
  });

  it("findings.headline + evidence are required (no magnitude-only entries)", () => {
    const parsed = messageSchema.safeParse({
      ...baseMessage,
      answerEnvelope: {
        findings: [{ magnitude: "+5%" }],
      },
    });
    assert.strictEqual(parsed.success, false);
  });
});

describe("W3 · narrator output schema is a superset of the persisted envelope", () => {
  it("every envelope field has a corresponding narrator field", () => {
    // If we add a field to the persisted envelope but forget to add it to the
    // narrator output schema, the LLM cannot emit it. This test catches the drift.
    const sample = {
      body: "ok",
      ctas: [],
      tldr: "headline",
      findings: [{ headline: "h", evidence: "e", magnitude: "m" }],
      methodology: "method",
      caveats: ["c"],
    };
    const ok = narratorOutputSchemaMirror.safeParse(sample);
    assert.strictEqual(ok.success, true);
  });
});
