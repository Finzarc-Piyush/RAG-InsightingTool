import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  InvestigationSummary,
  SessionAnalysisContext,
} from "../shared/schema.js";

// Stub Azure env so transitive imports don't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const {
  buildPriorInvestigationDigest,
  appendPriorInvestigation,
  formatPriorInvestigationsForPlanner,
} = await import("../lib/agents/runtime/priorInvestigations.js");
const { sessionAnalysisContextSchema } = await import("../shared/schema.js");

const baseContext = (): SessionAnalysisContext => ({
  version: 1,
  dataset: { shortDescription: "fixture", columnRoles: [], caveats: [] },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
});

const richSummary: InvestigationSummary = {
  hypotheses: [
    { text: "Saffola lost MT-channel volume due to pack-mix shift", status: "confirmed", evidenceCount: 2 },
    { text: "South-region distribution gap explains the dip", status: "refuted", evidenceCount: 1 },
    { text: "Festive timing shift caused the volume drop", status: "open", evidenceCount: 0 },
    { text: "Promo elasticity slipped vs benchmark", status: "partial", evidenceCount: 1 },
  ],
  findings: [
    { label: "Routine: Total volume 412 MT", significance: "routine" },
    { label: "Anomalous: South-MT volume dropped 8% MoM", significance: "anomalous" },
    { label: "Notable: 1L SKU mix shifted 3 ppt", significance: "notable" },
  ],
};

describe("W21 · buildPriorInvestigationDigest", () => {
  it("buckets hypotheses by status (confirmed/refuted/open) and prefers anomalous headline", () => {
    const d = buildPriorInvestigationDigest(
      "Why did Saffola lose share in MT in Q3?",
      richSummary,
      "2026-04-27T19:30Z"
    );
    assert.ok(d);
    assert.equal(d.at, "2026-04-27T19:30Z");
    assert.match(d.question, /^Why did Saffola/);
    assert.deepEqual(d.hypothesesConfirmed, [
      "Saffola lost MT-channel volume due to pack-mix shift",
    ]);
    assert.deepEqual(d.hypothesesRefuted, [
      "South-region distribution gap explains the dip",
    ]);
    // open + partial collapse into the open bucket.
    assert.equal(d.hypothesesOpen.length, 2);
    assert.match(d.headlineFinding!, /Anomalous: South-MT volume dropped 8% MoM/);
  });

  it("returns undefined when summary is empty AND no question text remains", () => {
    assert.equal(buildPriorInvestigationDigest("", undefined), undefined);
  });

  it("returns undefined when summary has zero meaningful content", () => {
    const empty = buildPriorInvestigationDigest("Q", {
      hypotheses: [],
      findings: [],
      openQuestions: [],
    });
    assert.equal(empty, undefined);
  });

  it("clips overly long hypothesis text with ellipsis", () => {
    const longHyp = "x".repeat(400);
    const d = buildPriorInvestigationDigest("Q", {
      hypotheses: [{ text: longHyp, status: "confirmed", evidenceCount: 1 }],
      findings: [],
    });
    assert.ok(d);
    assert.equal(d.hypothesesConfirmed[0].length, 200);
    assert.match(d.hypothesesConfirmed[0], /…$/);
  });

  it("falls back to first finding when no anomalous/notable exists", () => {
    const d = buildPriorInvestigationDigest("Q", {
      hypotheses: [{ text: "h1", status: "confirmed", evidenceCount: 1 }],
      findings: [{ label: "Routine fact only", significance: "routine" }],
    });
    assert.equal(d?.headlineFinding, "Routine fact only");
  });
});

describe("W21 · appendPriorInvestigation (FIFO cap)", () => {
  it("appends a digest immutably", () => {
    const ctx = baseContext();
    const digest = buildPriorInvestigationDigest("Q1", richSummary)!;
    const next = appendPriorInvestigation(ctx, digest);
    // Input untouched.
    assert.equal(ctx.sessionKnowledge.priorInvestigations, undefined);
    // Output has the new entry.
    assert.equal(next.sessionKnowledge.priorInvestigations?.length, 1);
    assert.equal(next.sessionKnowledge.priorInvestigations![0].question, "Q1");
  });

  it("evicts the oldest when over the 5-entry cap", () => {
    let ctx = baseContext();
    for (let i = 0; i < 7; i++) {
      const d = buildPriorInvestigationDigest(`Q${i}`, richSummary, `t${i}`)!;
      ctx = appendPriorInvestigation(ctx, d);
    }
    const arr = ctx.sessionKnowledge.priorInvestigations!;
    assert.equal(arr.length, 5);
    // Earliest two (Q0, Q1) evicted; Q2..Q6 retained in order.
    assert.equal(arr[0].question, "Q2");
    assert.equal(arr[4].question, "Q6");
  });

  it("output validates against sessionAnalysisContextSchema", () => {
    const digest = buildPriorInvestigationDigest("Q", richSummary)!;
    const out = appendPriorInvestigation(baseContext(), digest);
    const parsed = sessionAnalysisContextSchema.parse(out);
    assert.equal(parsed.sessionKnowledge.priorInvestigations?.length, 1);
  });

  it("legacy contexts without `priorInvestigations` parse cleanly", () => {
    const legacy = baseContext();
    const parsed = sessionAnalysisContextSchema.parse(legacy);
    assert.equal(parsed.sessionKnowledge.priorInvestigations, undefined);
  });
});

describe("W21 · formatPriorInvestigationsForPlanner", () => {
  it("returns '' when no prior investigations", () => {
    assert.equal(formatPriorInvestigationsForPlanner(baseContext()), "");
    assert.equal(formatPriorInvestigationsForPlanner(undefined), "");
  });

  it("emits a labelled markdown block listing each turn with its hypotheses + headline", () => {
    let ctx = baseContext();
    ctx = appendPriorInvestigation(
      ctx,
      buildPriorInvestigationDigest(
        "Why did Saffola lose share in MT in Q3?",
        richSummary,
        "2026-04-27T19:30Z"
      )!
    );
    const block = formatPriorInvestigationsForPlanner(ctx);
    assert.match(block, /^PRIOR_INVESTIGATIONS/);
    assert.match(block, /Why did Saffola/);
    assert.match(block, /Confirmed: Saffola lost MT-channel volume/);
    assert.match(block, /Refuted: South-region distribution gap/);
    assert.match(block, /Open: /);
    assert.match(block, /Headline: Anomalous: South-MT volume dropped 8% MoM/);
  });

  it("byte-stable across two calls with the same input (cache safety)", () => {
    let ctx = baseContext();
    ctx = appendPriorInvestigation(
      ctx,
      buildPriorInvestigationDigest("Q", richSummary, "fixed-ts")!
    );
    const a = formatPriorInvestigationsForPlanner(ctx);
    const b = formatPriorInvestigationsForPlanner(ctx);
    assert.equal(a, b);
  });
});
