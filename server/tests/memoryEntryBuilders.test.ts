import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTurnEndMemoryEntries,
  type TurnEndContext,
} from "../lib/agents/runtime/memoryEntryBuilders.js";
import type { Message, InvestigationSummary } from "../shared/schema.js";

const baseAssistant: Message = {
  role: "assistant",
  content: "Q1 sales rose 12% driven by East tech category.",
  charts: [],
  insights: [],
  timestamp: 1_773_000_000_000,
};

const baseCtx = (overrides: Partial<TurnEndContext> = {}): TurnEndContext => ({
  sessionId: "sess_abc",
  username: "u@example.com",
  turnId: "turn_001",
  dataVersion: 3,
  createdAt: 1_773_000_000_000,
  question: "Why did Q1 sales rise?",
  assistant: baseAssistant,
  ...overrides,
});

describe("W58 · buildTurnEndMemoryEntries", () => {
  it("emits a question_asked entry for every turn", () => {
    const entries = buildTurnEndMemoryEntries(baseCtx());
    const q = entries.find((e) => e.type === "question_asked");
    assert.ok(q, "expected a question_asked entry");
    assert.strictEqual(q!.actor, "user");
    assert.strictEqual(q!.title, "Why did Q1 sales rise?");
    assert.strictEqual(q!.dataVersion, 3);
    assert.strictEqual(q!.id, "sess_abc__turn_001__question_asked__0");
  });

  it("emits a hypothesis entry per investigationSummary.hypothesis (max 8)", () => {
    const investigationSummary: InvestigationSummary = {
      hypotheses: [
        { text: "East tech drove growth", status: "confirmed", evidenceCount: 3 },
        { text: "South dipped seasonally", status: "open", evidenceCount: 1 },
      ],
    };
    const entries = buildTurnEndMemoryEntries(
      baseCtx({ investigationSummary })
    );
    const h = entries.filter((e) => e.type === "hypothesis");
    assert.strictEqual(h.length, 2);
    assert.strictEqual(h[0]!.title, "East tech drove growth");
    assert.match(h[0]!.summary, /confirmed/);
    assert.strictEqual(h[1]!.id, "sess_abc__turn_001__hypothesis__1");
  });

  it("emits finding entries with significance carried through", () => {
    const investigationSummary: InvestigationSummary = {
      findings: [
        { label: "East region grew 23%", significance: "anomalous" },
        { label: "Total volume flat overall", significance: "routine" },
      ],
    };
    const entries = buildTurnEndMemoryEntries(
      baseCtx({ investigationSummary })
    );
    const f = entries.filter((e) => e.type === "finding");
    assert.strictEqual(f.length, 2);
    assert.strictEqual(f[0]!.significance, "anomalous");
    assert.strictEqual(f[1]!.significance, "routine");
  });

  it("emits chart_created entries with chart metadata in body", () => {
    const ctx = baseCtx({
      assistant: {
        ...baseAssistant,
        charts: [
          {
            type: "bar",
            title: "Sales by Region",
            x: "Region",
            y: "Sales",
            aggregate: "sum",
            // AMR7 · richer body — the key insight survives when present; the
            // spec (sans inline `data`) ships for spec-replay on recall.
            keyInsight: "East leads at 38% of Q3 total sales.",
          },
        ],
      },
    });
    const entries = buildTurnEndMemoryEntries(ctx);
    const c = entries.find((e) => e.type === "chart_created");
    assert.ok(c);
    assert.strictEqual(c!.title, "Sales by Region");
    const body = c!.body as Record<string, unknown>;
    assert.strictEqual(body.chartType, "bar");
    assert.strictEqual(body.x, "Region");
    assert.strictEqual(body.y, "Sales");
    assert.strictEqual(body.seriesColumn, undefined);
    assert.strictEqual(body.aggregate, "sum");
    assert.strictEqual(body.keyInsight, "East leads at 38% of Q3 total sales.");
    assert.strictEqual(body.businessCommentary, undefined);
    // chartSpec carries the spec (no inline `data`).
    const spec = body.chartSpec as Record<string, unknown>;
    assert.strictEqual(spec.type, "bar");
    assert.strictEqual(spec.title, "Sales by Region");
    assert.strictEqual(spec.x, "Region");
    assert.strictEqual(spec.y, "Sales");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(spec, "data"),
      false
    );
  });

  it("emits filter_applied entries from appliedFilters", () => {
    const entries = buildTurnEndMemoryEntries(
      baseCtx({
        appliedFilters: [
          {
            column: "Region",
            op: "in",
            values: ["East", "West", "North", "South", "Central", "X", "Y"],
          },
        ],
      })
    );
    const f = entries.find((e) => e.type === "filter_applied");
    assert.ok(f);
    assert.match(f!.title, /Region in/);
    assert.match(f!.title, /\+1 more/);
  });

  it("emits a dashboard_drafted entry when message.dashboardDraft is present", () => {
    const ctx = baseCtx({
      assistant: {
        ...baseAssistant,
        dashboardDraft: { name: "Q1 Sales Review", sheets: [{}, {}, {}] },
      },
    });
    const entries = buildTurnEndMemoryEntries(ctx);
    const d = entries.find((e) => e.type === "dashboard_drafted");
    assert.ok(d);
    assert.match(d!.title, /Q1 Sales Review/);
    assert.match(d!.summary, /3 sheet/);
  });

  it("emits a conclusion entry from answerEnvelope when present", () => {
    const ctx = baseCtx({
      assistant: {
        ...baseAssistant,
        answerEnvelope: {
          tldr: "Q1 sales rose 12%, driven by East tech.",
          findings: [
            { headline: "East tech grew 23%", evidence: "execute_query_plan" },
          ],
          nextSteps: ["Investigate Q2 carryover"],
        },
      },
    });
    const entries = buildTurnEndMemoryEntries(ctx);
    const c = entries.find((e) => e.type === "conclusion");
    assert.ok(c);
    assert.match(c!.summary, /TL;DR/);
    assert.match(c!.summary, /Next steps/);
  });

  it("omits a conclusion when there is nothing to summarize", () => {
    const ctx = baseCtx({
      assistant: { ...baseAssistant, content: "" },
    });
    const entries = buildTurnEndMemoryEntries(ctx);
    assert.strictEqual(
      entries.find((e) => e.type === "conclusion"),
      undefined
    );
  });

  it("ids are deterministic — same inputs produce identical entries (idempotent upserts)", () => {
    const a = buildTurnEndMemoryEntries(baseCtx());
    const b = buildTurnEndMemoryEntries(baseCtx());
    assert.deepStrictEqual(
      a.map((e) => e.id),
      b.map((e) => e.id)
    );
  });

  it("AMR7 · emits pivot_computed entries that reference past_analyses artifacts", () => {
    const ctx = baseCtx({
      pivotArtifacts: [
        {
          sessionId: "sess_abc",
          turnId: "turn_001",
          stepId: "exec_step_0",
          plan: { groupBy: ["Region"], aggregations: [] },
          pivotDefaults: { rows: ["Region"], values: ["Sales"] },
          columnHeaders: ["Region", "Sales"],
          rows: Array.from({ length: 8 }, (_, i) => ({
            Region: `R${i}`,
            Sales: 100 * (i + 1),
          })),
          questionContext: "Sales by region",
        },
      ],
    });
    const entries = buildTurnEndMemoryEntries(ctx);
    const p = entries.find((e) => e.type === "pivot_computed");
    assert.ok(p, "expected a pivot_computed entry");
    assert.strictEqual(p!.actor, "agent");
    assert.match(p!.title, /Sales by region/i);
    const body = p!.body as Record<string, unknown>;
    const ref = body.artifactRef as {
      artifactId: string;
      storage: { kind: "inline" | "blob" };
    };
    assert.ok(ref);
    // Deterministic id from (sessionId|turnId|stepId).
    assert.match(ref.artifactId, /^[0-9a-f]{32}$/);
    assert.strictEqual(ref.storage.kind, "inline");
    assert.strictEqual(body.rowCount, 8);
    assert.deepStrictEqual(body.columnHeaders, ["Region", "Sales"]);
  });

  it("AMR7 · pivot_computed entry id is stable across re-invocations (idempotent)", () => {
    const ctx = baseCtx({
      pivotArtifacts: [
        {
          sessionId: "sess_abc",
          turnId: "turn_001",
          stepId: "exec_step_0",
          plan: {},
          pivotDefaults: { rows: ["Region"] },
          columnHeaders: ["Region"],
          rows: [{ Region: "East" }],
        },
      ],
    });
    const a = buildTurnEndMemoryEntries(ctx).find(
      (e) => e.type === "pivot_computed"
    );
    const b = buildTurnEndMemoryEntries(ctx).find(
      (e) => e.type === "pivot_computed"
    );
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a!.id, b!.id);
    const aRef = (a!.body as Record<string, unknown>).artifactRef as {
      artifactId: string;
    };
    const bRef = (b!.body as Record<string, unknown>).artifactRef as {
      artifactId: string;
    };
    assert.strictEqual(aRef.artifactId, bRef.artifactId);
  });

  it("AMR7 · no pivot_computed entries when pivotArtifacts is empty / undefined", () => {
    const entries = buildTurnEndMemoryEntries(baseCtx({ pivotArtifacts: [] }));
    assert.strictEqual(
      entries.find((e) => e.type === "pivot_computed"),
      undefined
    );
    const entries2 = buildTurnEndMemoryEntries(baseCtx());
    assert.strictEqual(
      entries2.find((e) => e.type === "pivot_computed"),
      undefined
    );
  });

  it("AMR7 · large pivot row sets produce a blob storage reference", () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ x: i }));
    const ctx = baseCtx({
      pivotArtifacts: [
        {
          sessionId: "sess_abc",
          turnId: "turn_001",
          stepId: "exec_step_big",
          plan: {},
          pivotDefaults: { rows: ["x"] },
          columnHeaders: ["x"],
          rows: big,
        },
      ],
    });
    const p = buildTurnEndMemoryEntries(ctx).find(
      (e) => e.type === "pivot_computed"
    );
    assert.ok(p);
    const body = p!.body as Record<string, unknown>;
    const ref = body.artifactRef as {
      storage: { kind: "inline" | "blob"; blobName?: string };
    };
    assert.strictEqual(ref.storage.kind, "blob");
    assert.match(ref.storage.blobName ?? "", /^past-analyses-pivots\//);
  });
});
