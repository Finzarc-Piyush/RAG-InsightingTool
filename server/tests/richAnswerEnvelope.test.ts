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

  it("caps magnitudes at 6", () => {
    const out = chatResponseSchema.safeParse({
      ...base,
      magnitudes: Array.from({ length: 7 }, (_, i) => ({
        label: `m${i}`,
        value: `${i}%`,
      })),
    });
    assert.equal(out.success, false);
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
});
