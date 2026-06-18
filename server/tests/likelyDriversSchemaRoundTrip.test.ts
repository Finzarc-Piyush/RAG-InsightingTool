import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  likelyDriversSchema,
  likelyDriverSchema,
  messageAnswerEnvelopeSchema,
  dashboardAnswerEnvelopeSchema,
  messageSchema,
} from "../shared/schema.js";
import { finalAnswerEnvelopeSchema } from "../lib/agents/runtime/agentLoop/synthesis.js";
import { narratorOutputSchema } from "../lib/agents/runtime/narratorAgent.js";

/**
 * W-SR1 · the hedged causal lane (`likelyDrivers`) is declared on FIVE envelope
 * surfaces (narrator, synthesis fallback, persisted message, dashboard mirror,
 * and — via `export *` — the client re-export). A driver that parses on one MUST
 * parse on all, or "scope = everywhere" silently drops it on a forgotten schema
 * (L-019). These tests pin that parity, the confidence/basis clamp, and
 * back-compat with legacy envelopes that omit the field.
 */
const validDriver = {
  explanation: "more women survived, consistent with women-and-children-first",
  basis: "data" as const,
  confidence: "high" as const,
  testable: true,
};

describe("W-SR1 · likelyDrivers forward-parity across all producer schemas", () => {
  it("a valid drivers array parses on the message + dashboard + synthesis + narrator schemas", () => {
    const drivers = [validDriver];
    // message + dashboard accept it inside the envelope
    assert.ok(messageAnswerEnvelopeSchema.parse({ likelyDrivers: drivers }).likelyDrivers);
    assert.ok(dashboardAnswerEnvelopeSchema.parse({ likelyDrivers: drivers }).likelyDrivers);
    // synthesis fallback requires a body; narrator requires a body too
    assert.ok(
      finalAnswerEnvelopeSchema.parse({ body: "x", ctas: [], likelyDrivers: drivers }).likelyDrivers
    );
    assert.ok(narratorOutputSchema.parse({ body: "x", likelyDrivers: drivers }).likelyDrivers);
  });

  it("the full messageSchema round-trips an envelope carrying likelyDrivers", () => {
    const m = messageSchema.parse({
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      answerEnvelope: { tldr: "headline", likelyDrivers: [validDriver] },
    });
    assert.equal(m.answerEnvelope?.likelyDrivers?.[0].basis, "data");
  });
});

describe("W-SR1 · confidence is structurally clamped to what the basis supports", () => {
  it("general world-knowledge caps at low", () => {
    const [d] = likelyDriversSchema.parse([
      { explanation: "likely women-and-children-first", basis: "general", confidence: "high" },
    ])!;
    assert.equal(d.confidence, "low");
  });

  it("domain-pack basis caps at medium", () => {
    const d = likelyDriverSchema.parse({
      explanation: "likely festive demand per the pack",
      basis: "domain",
      confidence: "high",
    });
    assert.equal(d.confidence, "medium");
  });

  it("data basis may stay high", () => {
    const d = likelyDriverSchema.parse({
      explanation: "the Sex column explains part of the gap",
      basis: "data",
      confidence: "high",
    });
    assert.equal(d.confidence, "high");
  });
});

describe("W-SR1 · back-compat", () => {
  it("legacy envelopes without likelyDrivers still parse on every schema", () => {
    assert.equal(messageAnswerEnvelopeSchema.parse({ tldr: "x" }).likelyDrivers, undefined);
    assert.equal(dashboardAnswerEnvelopeSchema.parse({ tldr: "x" }).likelyDrivers, undefined);
    assert.equal(
      finalAnswerEnvelopeSchema.parse({ body: "x", ctas: [] }).likelyDrivers,
      undefined
    );
    assert.equal(narratorOutputSchema.parse({ body: "x" }).likelyDrivers, undefined);
    const legacy = messageSchema.parse({ role: "assistant", content: "x", timestamp: Date.now() });
    assert.equal(legacy.answerEnvelope, undefined);
  });
});
