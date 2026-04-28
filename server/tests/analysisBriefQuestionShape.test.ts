import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  analysisBriefSchema,
  questionShapeSchema,
  type AnalysisBrief,
} from "../shared/schema.js";

describe("questionShape schema", () => {
  it("accepts all canonical shapes including budget_reallocation", () => {
    for (const shape of [
      "driver_discovery",
      "variance_diagnostic",
      "trend",
      "comparison",
      "exploration",
      "descriptive",
      "budget_reallocation",
    ] as const) {
      const parsed = questionShapeSchema.safeParse(shape);
      assert.equal(parsed.success, true, `expected ${shape} to parse`);
    }
  });

  it("rejects unknown shapes", () => {
    const parsed = questionShapeSchema.safeParse("mystery");
    assert.equal(parsed.success, false);
  });
});

describe("analysisBriefSchema phase-1 additions", () => {
  const base: AnalysisBrief = {
    version: 1,
    clarifyingQuestions: [],
    epistemicNotes: [],
  };

  it("stays back-compat: brief without questionShape still parses", () => {
    const parsed = analysisBriefSchema.safeParse(base);
    assert.equal(parsed.success, true);
  });

  it("accepts candidateDriverDimensions alongside questionShape", () => {
    const brief: AnalysisBrief = {
      ...base,
      questionShape: "driver_discovery",
      candidateDriverDimensions: ["Region", "Category", "Channel"],
    };
    const parsed = analysisBriefSchema.safeParse(brief);
    assert.equal(parsed.success, true);
  });

  it("accepts candidateDriverDimensions of length 24", () => {
    const brief = {
      ...base,
      candidateDriverDimensions: Array.from({ length: 24 }, (_, i) => `col${i}`),
    };
    const parsed = analysisBriefSchema.safeParse(brief);
    assert.equal(parsed.success, true);
  });

  it("rejects candidateDriverDimensions longer than 24", () => {
    const brief = {
      ...base,
      candidateDriverDimensions: Array.from({ length: 25 }, (_, i) => `col${i}`),
    };
    const parsed = analysisBriefSchema.safeParse(brief);
    assert.equal(parsed.success, false);
  });
});
