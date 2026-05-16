import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldDispatchDeepInvestigation } from "../lib/agents/runtime/investigationDispatch.js";

/**
 * Helper to override DEEP_INVESTIGATION_ENABLED for a single test and
 * restore the prior value (whether set or unset) after.
 */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const orig = process.env.DEEP_INVESTIGATION_ENABLED;
  if (value === undefined) delete process.env.DEEP_INVESTIGATION_ENABLED;
  else process.env.DEEP_INVESTIGATION_ENABLED = value;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.DEEP_INVESTIGATION_ENABLED;
    else process.env.DEEP_INVESTIGATION_ENABLED = orig;
  }
}

describe("W73 · shouldDispatchDeepInvestigation — gate semantics", () => {
  it("returns fire=false when DEEP_INVESTIGATION_ENABLED is unset", () => {
    const d = withEnv(undefined, () =>
      shouldDispatchDeepInvestigation(
        "Show me top brands and tell me why MARICO leads",
      ),
    );
    assert.equal(d.fire, false);
    assert.match(d.reason, /DEEP_INVESTIGATION_ENABLED/);
  });

  it("returns fire=false when DEEP_INVESTIGATION_ENABLED is 'false'", () => {
    const d = withEnv("false", () =>
      shouldDispatchDeepInvestigation(
        "Show me top brands and tell me why MARICO leads",
      ),
    );
    assert.equal(d.fire, false);
  });

  it("returns fire=false when DEEP_INVESTIGATION_ENABLED is 'yes' (only 'true'/'1' accepted)", () => {
    const d = withEnv("yes", () =>
      shouldDispatchDeepInvestigation(
        "Show me top brands and tell me why MARICO leads",
      ),
    );
    assert.equal(d.fire, false);
  });

  it("accepts '1' as truthy for the master gate", () => {
    const d = withEnv("1", () =>
      shouldDispatchDeepInvestigation(
        "Show me top brands and tell me why MARICO leads",
      ),
    );
    assert.equal(d.fire, true);
  });
});

describe("W73 · shouldDispatchDeepInvestigation — multi-part detection (gate ON)", () => {
  it("fires on a clear two-part question", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation(
        "Show me top brands and tell me why MARICO leads",
      ),
    );
    assert.equal(d.fire, true);
    assert.ok(d.multiPart, "expected multiPart intent");
    assert.ok(
      d.multiPart!.subQuestions.length >= 2,
      "expected ≥ 2 sub-questions",
    );
    assert.match(d.reason, /multi-part question/);
    assert.match(d.reason, /trigger=/);
  });

  it("fires on three-part conjunctive question", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation(
        "Compare Q1 vs Q2 revenue, and check anomalies, and forecast Q3",
      ),
    );
    assert.equal(d.fire, true);
    assert.ok(d.multiPart, "expected multiPart intent");
    assert.ok(
      d.multiPart!.subQuestions.length >= 2,
      `expected ≥ 2 sub-questions, got ${d.multiPart!.subQuestions.length}`,
    );
  });

  it("does NOT fire on a single-part question with bare 'and' inside a noun phrase", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation("Show me sales and growth by region"),
    );
    // bare "and" between two metrics in a single ask — should stay single-flow
    assert.equal(d.fire, false);
    assert.match(d.reason, /single-part/);
  });

  it("does NOT fire on a simple descriptive question", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation("What were sales last quarter?"),
    );
    assert.equal(d.fire, false);
  });

  it("returns fire=false on empty question even when gate is on", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation(""),
    );
    assert.equal(d.fire, false);
    assert.match(d.reason, /empty question/);
  });

  it("returns fire=false on undefined question", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation(undefined),
    );
    assert.equal(d.fire, false);
  });

  it("returns fire=false on whitespace-only question", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation("   \t   "),
    );
    assert.equal(d.fire, false);
  });
});

describe("W73 · decision shape", () => {
  it("reason string fits within the SSE-safe length envelope", () => {
    const d = withEnv("true", () =>
      shouldDispatchDeepInvestigation(
        "Show me top brands and tell me why MARICO leads",
      ),
    );
    assert.ok(d.reason.length <= 500, `reason should be ≤ 500 chars`);
  });

  it("multiPart carries the original question and the trigger", () => {
    const original = "Show me top brands and tell me why MARICO leads";
    const d = withEnv("true", () => shouldDispatchDeepInvestigation(original));
    assert.ok(d.multiPart);
    assert.equal(d.multiPart!.original, original);
    assert.ok(d.multiPart!.trigger);
  });
});
