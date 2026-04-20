import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "../lib/agents/runtime/skills/index.js";
import {
  formatSkillsManifestForPlanner,
  listRegisteredSkills,
  registerSkill,
  selectSkill,
} from "../lib/agents/runtime/skills/index.js";

const dummyCtx = (): AgentExecutionContext => ({
  sessionId: "s",
  question: "why did sales fall in east last quarter",
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

const dummyBrief: AnalysisBrief = {
  version: 1,
  clarifyingQuestions: [],
  epistemicNotes: [],
};

const makeSkill = (
  name: string,
  shape: AnalysisBrief["questionShape"]
): AnalysisSkill => ({
  name,
  description: `test skill ${name}`,
  handles: shape ? [shape] : [],
  appliesTo: (brief) => brief.questionShape === shape,
  plan: (): SkillInvocation => ({
    id: `${name}-inv`,
    label: name,
    steps: [],
  }),
});

describe("skills registry behavior", () => {
  // These tests mutate module-level env flags; make sure we don't leak state.
  const originalEnabled = process.env.DEEP_ANALYSIS_SKILLS_ENABLED;
  const originalAllowlist = process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST;

  afterEach(() => {
    process.env.DEEP_ANALYSIS_SKILLS_ENABLED = originalEnabled;
    process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST = originalAllowlist;
  });

  it("returns empty manifest when flag is off", () => {
    delete process.env.DEEP_ANALYSIS_SKILLS_ENABLED;
    assert.equal(formatSkillsManifestForPlanner(), "");
  });

  it("emits manifest lines for registered skills when enabled", () => {
    process.env.DEEP_ANALYSIS_SKILLS_ENABLED = "true";
    registerSkill(makeSkill("test_variance", "variance_diagnostic"));
    const manifest = formatSkillsManifestForPlanner();
    assert.ok(manifest.includes("test_variance"));
    assert.ok(manifest.includes("test skill test_variance"));
  });

  it("selectSkill returns null when flag is off regardless of registry", () => {
    delete process.env.DEEP_ANALYSIS_SKILLS_ENABLED;
    registerSkill(makeSkill("test_selection", "variance_diagnostic"));
    const out = selectSkill(
      { ...dummyBrief, questionShape: "variance_diagnostic" },
      dummyCtx()
    );
    assert.equal(out, null);
  });

  it("selectSkill honours DEEP_ANALYSIS_SKILL_ALLOWLIST", () => {
    process.env.DEEP_ANALYSIS_SKILLS_ENABLED = "true";
    registerSkill(makeSkill("allowed_skill", "variance_diagnostic"));
    registerSkill(makeSkill("blocked_skill", "variance_diagnostic"));
    process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST = "allowed_skill";
    const out = selectSkill(
      { ...dummyBrief, questionShape: "variance_diagnostic" },
      dummyCtx()
    );
    assert.ok(out, "expected a selection");
    assert.equal(out!.name, "allowed_skill");
  });
});
