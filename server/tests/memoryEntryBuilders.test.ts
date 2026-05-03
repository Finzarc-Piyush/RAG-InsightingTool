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
          },
        ],
      },
    });
    const entries = buildTurnEndMemoryEntries(ctx);
    const c = entries.find((e) => e.type === "chart_created");
    assert.ok(c);
    assert.strictEqual(c!.title, "Sales by Region");
    assert.deepStrictEqual(c!.body, {
      chartType: "bar",
      x: "Region",
      y: "Sales",
      seriesColumn: undefined,
      aggregate: "sum",
    });
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
});
