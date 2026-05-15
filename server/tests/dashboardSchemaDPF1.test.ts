import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dashboardSchema,
  dashboardSpecSchema,
  dashboardAnswerEnvelopeSchema,
  messageAnswerEnvelopeSchema,
  businessActionItemSchema,
  type Dashboard,
  type DashboardSpec,
  type BusinessActionItem,
} from "../shared/schema.js";

/**
 * DPF1 · pin the schema expansion: dashboard schemas now mirror the message
 * envelope's caps and carry the four message-only fields (businessActions,
 * followUpPrompts, investigationSummary, priorInvestigationsSnapshot) so the
 * chat → dashboard round-trip stops silently dropping content.
 *
 * Tests pin the contract from both directions:
 *   - the new fields are accepted on `dashboardSpecSchema` AND `dashboardSchema`
 *   - the answer envelope's caps no longer truncate vs `messageAnswerEnvelopeSchema`
 *   - back-compat: pre-DPF1 dashboards (without the new fields) still validate
 *   - over-cap inputs still fail (we raised caps, didn't remove them)
 */

const baseValidSpec = (): DashboardSpec => ({
  name: "Q4 sales recovery dashboard",
  template: "deep_dive",
  defaultSheetId: "sheet_summary",
  sheets: [
    {
      id: "sheet_summary",
      name: "Executive Summary",
      charts: [],
    },
  ],
});

const baseValidDashboard = (): Dashboard => ({
  id: "dash-1",
  username: "user@example.com",
  name: "Q4 sales recovery dashboard",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  charts: [],
});

describe("DPF1 · dashboard schemas accept the four new message-mirroring fields", () => {
  it("dashboardSpecSchema accepts businessActions / followUpPrompts / investigationSummary / priorInvestigationsSnapshot", () => {
    const spec = {
      ...baseValidSpec(),
      businessActions: [
        {
          title: "Reallocate Q4 trade spend toward MARICO ZAYO",
          rationale:
            "ZAYO's incremental ROAS lifted +18% over the prior quarter while LASHE plateaued; reallocating ~₹2cr captures the tail.",
          horizon: "this_quarter",
          confidence: "medium",
          dependencies: "Confirm channel-level budget headroom with Finance",
          expectedImpact: "+₹3.4cr value sales over next 90 days",
        },
      ],
      followUpPrompts: [
        "What's driving ZAYO's ROAS lift?",
        "Compare LASHE vs ZAYO by region",
      ],
      investigationSummary: {
        hypotheses: [
          { text: "Channel mix shifted toward MT", status: "confirmed", evidenceCount: 3 },
        ],
        findings: [{ label: "ZAYO drove +18% lift", significance: "notable" }],
        openQuestions: [
          { question: "Is the lift sustainable beyond Q4?", priority: "medium" },
        ],
      },
      priorInvestigationsSnapshot: [
        {
          at: "2026-04-01",
          question: "Why is FEMALE SHOWER GEL share declining?",
          hypothesesConfirmed: ["Distribution gap in metro MT"],
          hypothesesRefuted: [],
          hypothesesOpen: ["Premiumisation effect"],
          headlineFinding: "Metro MT distribution dropped 4pp YoY",
        },
      ],
    } satisfies DashboardSpec;

    const out = dashboardSpecSchema.safeParse(spec);
    assert.equal(out.success, true, out.success ? "" : JSON.stringify(out.error.issues));
  });

  it("dashboardSchema (Cosmos doc) accepts the same four fields", () => {
    const doc = {
      ...baseValidDashboard(),
      businessActions: [
        {
          title: "Pause discount on PURITE in Off-VN",
          rationale:
            "Sell-out velocity flat despite 12% promo intensity — ROI well below threshold.",
          horizon: "now",
          confidence: "high",
        },
      ],
      followUpPrompts: ["What's the elasticity by SKU?"],
      investigationSummary: {
        hypotheses: [
          { text: "Promo cannibalising baseline", status: "partial", evidenceCount: 2 },
        ],
      },
      priorInvestigationsSnapshot: [],
    } satisfies Dashboard;

    const out = dashboardSchema.safeParse(doc);
    assert.equal(out.success, true, out.success ? "" : JSON.stringify(out.error.issues));
  });

  it("back-compat: a dashboard with NONE of the new fields still parses", () => {
    const out = dashboardSchema.safeParse(baseValidDashboard());
    assert.equal(out.success, true);
  });

  it("back-compat: a spec with NONE of the new fields still parses", () => {
    const out = dashboardSpecSchema.safeParse(baseValidSpec());
    assert.equal(out.success, true);
  });

  it("rejects > 8 businessActions on the dashboard spec", () => {
    const bigItem: BusinessActionItem = {
      title: "Action with sufficient length",
      rationale: "Rationale long enough to clear the min(10) check.",
      horizon: "now",
      confidence: "low",
    };
    const spec = {
      ...baseValidSpec(),
      businessActions: Array.from({ length: 9 }, () => bigItem),
    };
    const out = dashboardSpecSchema.safeParse(spec);
    assert.equal(out.success, false);
  });

  it("businessActionItemSchema is the single source of truth (round-trip)", () => {
    const item: BusinessActionItem = {
      title: "Test action item",
      rationale: "Rationale meeting the min(10) threshold.",
      horizon: "strategic",
      confidence: "high",
    };
    assert.equal(businessActionItemSchema.safeParse(item).success, true);
    // Min-length checks survived the extraction.
    assert.equal(
      businessActionItemSchema.safeParse({ ...item, title: "abc" }).success,
      false,
      "title min(4) should still reject"
    );
    assert.equal(
      businessActionItemSchema.safeParse({ ...item, rationale: "short" }).success,
      false,
      "rationale min(10) should still reject"
    );
  });
});

describe("DPF1 · dashboardAnswerEnvelopeSchema caps now match messageAnswerEnvelopeSchema", () => {
  it("accepts 7 findings (was 5)", () => {
    const finding = { headline: "h", evidence: "e" };
    const env = { findings: Array.from({ length: 7 }, () => finding) };
    assert.equal(dashboardAnswerEnvelopeSchema.safeParse(env).success, true);
    assert.equal(messageAnswerEnvelopeSchema.safeParse(env).success, true);
  });

  it("accepts 1200-char evidence (was 600)", () => {
    const env = { findings: [{ headline: "h", evidence: "x".repeat(1200) }] };
    assert.equal(dashboardAnswerEnvelopeSchema.safeParse(env).success, true);
  });

  it("accepts 6 implications (was 4)", () => {
    const imp = { statement: "s", soWhat: "w" };
    const env = { implications: Array.from({ length: 6 }, () => imp) };
    assert.equal(dashboardAnswerEnvelopeSchema.safeParse(env).success, true);
  });

  it("accepts 6 recommendations (was 4)", () => {
    const rec = { action: "a", rationale: "r" };
    const env = { recommendations: Array.from({ length: 6 }, () => rec) };
    assert.equal(dashboardAnswerEnvelopeSchema.safeParse(env).success, true);
  });

  it("accepts 1400-char methodology (was 500), 5 caveats (was 3), 900-char domainLens (was 500)", () => {
    const env = {
      methodology: "m".repeat(1400),
      caveats: ["c1", "c2", "c3", "c4", "c5"],
      domainLens: "d".repeat(900),
    };
    assert.equal(dashboardAnswerEnvelopeSchema.safeParse(env).success, true);
  });

  it("still rejects over-cap inputs (caps moved up, weren't removed)", () => {
    assert.equal(
      dashboardAnswerEnvelopeSchema.safeParse({
        findings: Array.from({ length: 16 }, () => ({ headline: "h", evidence: "e" })),
      }).success,
      false
    );
    assert.equal(
      dashboardAnswerEnvelopeSchema.safeParse({
        methodology: "m".repeat(3501),
      }).success,
      false
    );
  });
});
