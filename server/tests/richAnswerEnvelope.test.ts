import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { chatResponseSchema, messageSchema } from "../shared/schema.js";

describe("Phase-1 rich envelope — chatResponseSchema", () => {
  const base = {
    answer: "The largest driver appears to be Category.",
  };

  it("parses a response with no Phase-1 fields (back-compat)", () => {
    const out = chatResponseSchema.safeParse(base);
    assert.equal(out.success, true);
  });

  it("accepts magnitudes + unexplained when present", () => {
    const out = chatResponseSchema.safeParse({
      ...base,
      magnitudes: [
        { label: "East tech decline Mar→Apr", value: "-23.4%", confidence: "high" },
        { label: "Volume drop", value: "-$1.2M" },
      ],
      unexplained:
        "Composition shift between product sub-categories was not isolated because no sub-category column exists.",
    });
    assert.equal(out.success, true);
    assert.equal(out.success && out.data.magnitudes?.length, 2);
  });

  it("rejects confidence values outside the enum", () => {
    const out = chatResponseSchema.safeParse({
      ...base,
      magnitudes: [{ label: "x", value: "y", confidence: "super high" }],
    });
    assert.equal(out.success, false);
  });

  it("does NOT cap magnitudes (dashboards can carry many KPIs)", () => {
    // The former `.max(10)` cap was removed: a "build a dashboard" turn legitimately
    // produces a KPI strip with more than 10 magnitudes, and the cap rejected the
    // whole envelope ("Array must contain at most 10 element(s)").
    const out = chatResponseSchema.safeParse({
      ...base,
      magnitudes: Array.from({ length: 24 }, (_, i) => ({
        label: `m${i}`,
        value: `${i}%`,
      })),
    });
    assert.equal(out.success, true);
    assert.equal(out.success && out.data.magnitudes?.length, 24);
  });
});

describe("Phase-1 rich envelope — messageSchema", () => {
  it("accepts a persisted assistant message carrying magnitudes", () => {
    const out = messageSchema.safeParse({
      role: "assistant",
      content: "Here are the top drivers of Sales.",
      timestamp: Date.now(),
      magnitudes: [{ label: "Category contribution", value: "62%" }],
    });
    assert.equal(out.success, true);
  });

  it("accepts persisted investigatedSubQuestions (durable 'Investigated' badge)", () => {
    const out = messageSchema.safeParse({
      role: "assistant",
      content: "Adherence analysis.",
      timestamp: Date.now(),
      investigatedSubQuestions: [
        { id: "sq1", question: "Which TSOE has lowest compliance?", chartCount: 2 },
      ],
    });
    assert.equal(out.success, true);
  });

  it("rejects more than 16 investigatedSubQuestions (cap matches chatStream persist)", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({
      id: `sq${i}`,
      question: `q${i}`,
      chartCount: 0,
    }));
    const out = messageSchema.safeParse({
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      investigatedSubQuestions: many,
    });
    assert.equal(out.success, false);
  });
});
