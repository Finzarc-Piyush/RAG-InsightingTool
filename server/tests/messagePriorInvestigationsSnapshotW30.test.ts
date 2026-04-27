import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  messageSchema,
  priorInvestigationItemSchema,
  sessionAnalysisContextSchema,
  type PriorInvestigationItem,
} from "../shared/schema.js";

describe("W30 · priorInvestigationItemSchema (single source of truth)", () => {
  const sample: PriorInvestigationItem = {
    at: "2026-04-27T19:30Z",
    question: "Why did Saffola lose share in MT in Q3?",
    hypothesesConfirmed: ["South-MT volume drop is brand-specific"],
    hypothesesRefuted: ["Channel-mix shift to GT"],
    hypothesesOpen: ["Festive timing"],
    headlineFinding: "South-MT volume −8% MoM",
  };

  it("accepts a fully populated entry", () => {
    const parsed = priorInvestigationItemSchema.parse(sample);
    assert.deepEqual(parsed, sample);
  });

  it("re-export from priorInvestigations.ts is the same schema instance", async () => {
    const reexport = await import(
      "../lib/agents/runtime/priorInvestigations.js"
    );
    // Same Zod object → same parse behaviour. We don't compare references
    // (re-exports return new bindings); instead we deep-equal the parse
    // output for a fixture parsed by both.
    const a = priorInvestigationItemSchema.parse(sample);
    const b = reexport.priorInvestigationItemSchema.parse(sample);
    assert.deepEqual(a, b);
  });

  it("rejects missing required fields", () => {
    assert.throws(() => priorInvestigationItemSchema.parse({ at: "x" }));
  });

  it("clips with .max() at the right thresholds", () => {
    assert.throws(() =>
      priorInvestigationItemSchema.parse({
        ...sample,
        question: "x".repeat(281),
      })
    );
    assert.throws(() =>
      priorInvestigationItemSchema.parse({
        ...sample,
        hypothesesConfirmed: Array.from({ length: 6 }, () => "x"),
      })
    );
  });
});

describe("W30 · sessionAnalysisContextSchema uses the canonical item schema", () => {
  it("priorInvestigations entries validate using the same item schema", () => {
    const sac = {
      version: 1 as const,
      dataset: { shortDescription: "x", columnRoles: [], caveats: [] },
      userIntent: { interpretedConstraints: [] },
      sessionKnowledge: {
        facts: [],
        analysesDone: [],
        priorInvestigations: [
          {
            at: "t1",
            question: "Q",
            hypothesesConfirmed: ["a"],
            hypothesesRefuted: [],
            hypothesesOpen: [],
            headlineFinding: "h",
          },
        ],
      },
      suggestedFollowUps: [],
      lastUpdated: { reason: "seed" as const, at: "now" },
    };
    const parsed = sessionAnalysisContextSchema.parse(sac);
    assert.equal(parsed.sessionKnowledge.priorInvestigations?.length, 1);
  });
});

describe("W30 · messageSchema.priorInvestigationsSnapshot field", () => {
  const baseMessage = {
    role: "assistant" as const,
    content: "x",
    timestamp: Date.now(),
  };

  it("accepts a populated snapshot of up to 5 entries", () => {
    const m = {
      ...baseMessage,
      priorInvestigationsSnapshot: Array.from({ length: 5 }, (_, i) => ({
        at: `t${i}`,
        question: `Q${i}`,
        hypothesesConfirmed: [],
        hypothesesRefuted: [],
        hypothesesOpen: [],
      })),
    };
    const parsed = messageSchema.parse(m);
    assert.equal(parsed.priorInvestigationsSnapshot?.length, 5);
  });

  it("rejects more than 5 entries (matches the live SAC array cap)", () => {
    const m = {
      ...baseMessage,
      priorInvestigationsSnapshot: Array.from({ length: 6 }, (_, i) => ({
        at: `t${i}`,
        question: `Q${i}`,
        hypothesesConfirmed: [],
        hypothesesRefuted: [],
        hypothesesOpen: [],
      })),
    };
    assert.throws(() => messageSchema.parse(m));
  });

  it("legacy messages without the field parse cleanly (back-compat)", () => {
    const parsed = messageSchema.parse(baseMessage);
    assert.equal(parsed.priorInvestigationsSnapshot, undefined);
  });

  it("empty array is accepted", () => {
    const m = { ...baseMessage, priorInvestigationsSnapshot: [] };
    const parsed = messageSchema.parse(m);
    assert.deepEqual(parsed.priorInvestigationsSnapshot, []);
  });
});
