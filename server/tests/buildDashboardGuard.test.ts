import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import type { ChartSpec, AnalysisBrief } from "../shared/schema.js";
import { shouldBuildDashboard } from "../lib/agents/runtime/buildDashboard.js";

const chart = (title: string): ChartSpec =>
  ({
    type: "bar",
    title,
    x: "Region",
    y: "Sales_sum",
  }) as unknown as ChartSpec;

const brief = (partial: Partial<AnalysisBrief> = {}): AnalysisBrief => ({
  version: 1,
  clarifyingQuestions: [],
  epistemicNotes: [],
  ...partial,
});

describe("shouldBuildDashboard", () => {
  const originalFlag = process.env.DASHBOARD_AUTOGEN_ENABLED;

  afterEach(() => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = originalFlag;
  });

  it("returns false when the flag is off", () => {
    delete process.env.DASHBOARD_AUTOGEN_ENABLED;
    assert.equal(
      shouldBuildDashboard({
        brief: brief({ requestsDashboard: true }),
        charts: [chart("a")],
      }),
      false
    );
  });

  it("returns false when requestsDashboard is not set on the brief", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    assert.equal(
      shouldBuildDashboard({
        brief: brief(),
        charts: [chart("a")],
      }),
      false
    );
  });

  it("returns false when no charts were produced", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    assert.equal(
      shouldBuildDashboard({
        brief: brief({ requestsDashboard: true }),
        charts: [],
      }),
      false
    );
  });

  it("returns true when flag + trigger + at least one chart are present", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    assert.equal(
      shouldBuildDashboard({
        brief: brief({ requestsDashboard: true }),
        charts: [chart("a")],
      }),
      true
    );
  });

  it("returns false when the brief is missing entirely", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    assert.equal(
      shouldBuildDashboard({ brief: undefined, charts: [chart("a")] }),
      false
    );
  });
});
