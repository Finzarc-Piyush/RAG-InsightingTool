import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  dashboardAutogenRolloutPct,
  isUserEnrolledInDashboardAutogenRollout,
  shouldBuildDashboard,
  isDashboardAutogenEnabled,
} from "../lib/agents/runtime/dashboardAutogenGate.js";
import type { AnalysisBrief, ChartSpec } from "../shared/schema.js";

/**
 * W7.6 · Pin the rollout ramp's behaviour. The whole point is operators can
 * gradually ramp DASHBOARD_AUTOGEN_ENABLED from 25 → 50 → 100% and roll back
 * by lowering a single env var without redeploying.
 */

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const briefRequestingDashboard: AnalysisBrief = {
  questionShape: "exploration",
  requestsDashboard: true,
} as AnalysisBrief;

const oneChart: ChartSpec[] = [
  { type: "bar", title: "Sales by region", x: "region", y: "sales" } as ChartSpec,
];

describe("dashboardAutogenRolloutPct", () => {
  it("defaults to 100 when env is unset", () => {
    delete process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT;
    assert.strictEqual(dashboardAutogenRolloutPct(), 100);
  });

  it("clamps out-of-range values", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "-10";
    assert.strictEqual(dashboardAutogenRolloutPct(), 0);
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "999";
    assert.strictEqual(dashboardAutogenRolloutPct(), 100);
  });

  it("returns 100 for non-numeric values rather than failing closed", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "not a number";
    assert.strictEqual(dashboardAutogenRolloutPct(), 100);
  });

  it("accepts integer percentages", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "25";
    assert.strictEqual(dashboardAutogenRolloutPct(), 25);
  });
});

describe("isUserEnrolledInDashboardAutogenRollout", () => {
  it("returns true for everyone at 100%", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    for (const u of ["a@b", "c@d", "e@f", undefined]) {
      assert.strictEqual(isUserEnrolledInDashboardAutogenRollout(u), true);
    }
  });

  it("returns false for everyone at 0%", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "0";
    for (const u of ["a@b", "c@d", "e@f"]) {
      assert.strictEqual(isUserEnrolledInDashboardAutogenRollout(u), false);
    }
  });

  it("is deterministic across calls for the same user at non-extreme percentages", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "50";
    const a = isUserEnrolledInDashboardAutogenRollout("alice@example.com");
    const b = isUserEnrolledInDashboardAutogenRollout("alice@example.com");
    const c = isUserEnrolledInDashboardAutogenRollout("alice@example.com");
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  it("distributes ~50/50 across many users at 50%", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "50";
    let trueCount = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (isUserEnrolledInDashboardAutogenRollout(`user_${i}@example.com`)) trueCount++;
    }
    assert.ok(
      trueCount > 400 && trueCount < 600,
      `expected ~500 enrolled out of 1000, got ${trueCount}`
    );
  });

  it("is case-insensitive on the user key (alice@x = ALICE@X)", () => {
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "50";
    assert.strictEqual(
      isUserEnrolledInDashboardAutogenRollout("alice@example.com"),
      isUserEnrolledInDashboardAutogenRollout("Alice@Example.COM")
    );
  });
});

describe("shouldBuildDashboard · ramp gating", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("falls through to false when ramp says user is excluded, even with all other gates open", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "0";
    assert.strictEqual(
      shouldBuildDashboard({
        brief: briefRequestingDashboard,
        charts: oneChart,
        userKey: "alice@example.com",
      }),
      false
    );
  });

  it("returns true when all gates open (flag, requestsDashboard, charts present, ramp 100)", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "true";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    assert.strictEqual(
      shouldBuildDashboard({
        brief: briefRequestingDashboard,
        charts: oneChart,
        userKey: "alice@example.com",
      }),
      true
    );
  });

  it("the existing flag-off gate still wins when ramp would otherwise enroll", () => {
    process.env.DASHBOARD_AUTOGEN_ENABLED = "false";
    process.env.DASHBOARD_AUTOGEN_ROLLOUT_PCT = "100";
    assert.strictEqual(isDashboardAutogenEnabled(), false);
    assert.strictEqual(
      shouldBuildDashboard({
        brief: briefRequestingDashboard,
        charts: oneChart,
        userKey: "alice@example.com",
      }),
      false
    );
  });
});
