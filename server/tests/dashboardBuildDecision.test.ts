import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { dashboardBuildDecision } from "../lib/agents/runtime/dashboardAutogenGate.js";
import type { ChartSpec } from "../shared/schema.js";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const charts: ChartSpec[] = [
  { type: "bar", title: "Sales", x: "region", y: "sales" } as ChartSpec,
];

describe("dashboardBuildDecision", () => {
  it("auto_create with all gates open → build + persist", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "auto_create", charts, userKey: "u@x" }),
      { build: true, persist: true }
    );
  });

  it("offer with all gates open → build but DO NOT persist", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "offer", charts, userKey: "u@x" }),
      { build: true, persist: false }
    );
  });

  it("none → never build", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "none", charts, userKey: "u@x" }),
      { build: false, persist: false }
    );
  });

  it("feature flag off → no build even on auto_create", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "false";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "auto_create", charts, userKey: "u@x" }),
      { build: false, persist: false }
    );
  });

  it("zero charts → no build (would be a useless dashboard)", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "auto_create", charts: [], userKey: "u@x" }),
      { build: false, persist: false }
    );
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "offer", charts: [], userKey: "u@x" }),
      { build: false, persist: false }
    );
  });

  it("user excluded by ramp → no build", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "0";
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "auto_create", charts, userKey: "u@x" }),
      { build: false, persist: false }
    );
    assert.deepStrictEqual(
      dashboardBuildDecision({ intent: "offer", charts, userKey: "u@x" }),
      { build: false, persist: false }
    );
  });
});
