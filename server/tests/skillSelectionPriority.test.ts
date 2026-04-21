import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "../lib/agents/runtime/skills/index.js";
import {
  registerSkill,
  selectSkill,
} from "../lib/agents/runtime/skills/index.js";

const dummyCtx = (): AgentExecutionContext => ({
  sessionId: "s",
  question: "why did sales fall in east q1 vs q2",
  data: [],
  summary: {
    columnCount: 0,
    columns: [],
    numericColumns: [],
    dateColumns: [],
    rowCount: 0,
  } as unknown as DataSummary,
  chatHistory: [],
  mode: "analysis",
});

const baseBrief: AnalysisBrief = {
  version: 1,
  clarifyingQuestions: [],
  epistemicNotes: [],
};

/**
 * Two competing test skills with different priorities. Both report they
 * "apply" when the brief carries `questionShape=variance_diagnostic`;
 * the narrow one additionally expects `comparisonPeriods` to be present,
 * but its `appliesTo` is the same for this priority-only check.
 */
const makeSkill = (
  name: string,
  priority: number | undefined
): AnalysisSkill => ({
  name,
  description: `priority-test ${name}`,
  handles: ["variance_diagnostic"],
  priority,
  appliesTo: (brief) => brief.questionShape === "variance_diagnostic",
  plan: (): SkillInvocation => ({
    id: `${name}-inv`,
    label: name,
    steps: [],
  }),
});

describe("skill selection is priority-ordered", () => {
  const originalEnabled = process.env.DEEP_ANALYSIS_SKILLS_ENABLED;
  const originalAllowlist = process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST;

  afterEach(() => {
    // `process.env.X = undefined` sets the env to the literal string
    // "undefined" rather than deleting. Branch explicitly so allowlist
    // leakage does not poison subsequent tests (and subsequent test
    // files, which share this process under node:test).
    if (originalEnabled === undefined) {
      delete process.env.DEEP_ANALYSIS_SKILLS_ENABLED;
    } else {
      process.env.DEEP_ANALYSIS_SKILLS_ENABLED = originalEnabled;
    }
    if (originalAllowlist === undefined) {
      delete process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST;
    } else {
      process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST = originalAllowlist;
    }
  });

  it("higher-priority skill wins over an earlier-registered broad skill", () => {
    process.env.DEEP_ANALYSIS_SKILLS_ENABLED = "true";
    // Register broad first (would win under first-match-wins).
    registerSkill(makeSkill("broad_variance_test", 0));
    // Narrow registered after but higher priority.
    registerSkill(makeSkill("narrow_variance_test", 10));
    // Restrict the allowlist to just these two so built-ins don't
    // interfere with the expected winner.
    process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST =
      "broad_variance_test,narrow_variance_test";

    const picked = selectSkill(
      { ...baseBrief, questionShape: "variance_diagnostic" },
      dummyCtx()
    );

    assert.ok(picked, "expected a selection");
    assert.equal(picked!.name, "narrow_variance_test");
  });

  it("registration order breaks ties when priority is equal", () => {
    process.env.DEEP_ANALYSIS_SKILLS_ENABLED = "true";
    registerSkill(makeSkill("tie_first_test", undefined));
    registerSkill(makeSkill("tie_second_test", undefined));
    process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST =
      "tie_first_test,tie_second_test";

    const picked = selectSkill(
      { ...baseBrief, questionShape: "variance_diagnostic" },
      dummyCtx()
    );

    assert.ok(picked, "expected a selection");
    assert.equal(picked!.name, "tie_first_test");
  });

  it("time_window_diff wins over variance_decomposer when comparisonPeriods is on the brief", () => {
    process.env.DEEP_ANALYSIS_SKILLS_ENABLED = "true";
    process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST =
      "variance_decomposer,time_window_diff";

    const picked = selectSkill(
      {
        ...baseBrief,
        questionShape: "variance_diagnostic",
        outcomeMetricColumn: "Sales",
        comparisonPeriods: {
          a: [{ column: "Quarter", op: "in", values: ["Q1"] }],
          b: [{ column: "Quarter", op: "in", values: ["Q2"] }],
          aLabel: "Q1",
          bLabel: "Q2",
        },
      },
      dummyCtx()
    );

    assert.ok(picked, "expected a selection");
    assert.equal(picked!.name, "time_window_diff");
  });

  it("falls back to variance_decomposer when the brief has no comparisonPeriods", () => {
    process.env.DEEP_ANALYSIS_SKILLS_ENABLED = "true";
    process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST =
      "variance_decomposer,time_window_diff";

    const ctx = dummyCtx();
    // variance_decomposer needs a date column in the summary to plan.
    // appliesTo doesn't check it, but we include one so the fixture is
    // realistic for downstream consumers.
    (ctx.summary as unknown as { dateColumns: string[] }).dateColumns = [
      "Date",
    ];

    const picked = selectSkill(
      {
        ...baseBrief,
        questionShape: "variance_diagnostic",
        outcomeMetricColumn: "Sales",
      },
      ctx
    );

    assert.ok(picked, "expected a selection");
    assert.equal(picked!.name, "variance_decomposer");
  });
});
