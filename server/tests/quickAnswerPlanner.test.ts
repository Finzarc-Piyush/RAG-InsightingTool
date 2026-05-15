import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runQuickLookupPlanner } from "../lib/agents/runtime/quickAnswerPlanner.js";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

/**
 * Wave QL1 · Quick-lookup planner LLM call. Pins:
 *   - happy path produces a valid QueryPlanBody
 *   - Zod-invalid response on first call → one retry → success
 *   - terminal Zod fail → null (caller falls through to full loop)
 *   - LLM throw → null (graceful)
 *   - LLM_PURPOSE.QUICK_LOOKUP_PLANNER actually fires
 *   - schema column allowlist works (downstream validation catches bogus columns)
 */

const baseSummary: DataSummary = {
  rowCount: 100,
  columnCount: 3,
  numericColumns: ["Sales"],
  dateColumns: [],
  columns: [
    {
      name: "State",
      type: "string",
      sampleValues: ["CA", "TX"],
      topValues: [{ value: "CA", count: 40 }, { value: "TX", count: 30 }],
    },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
  ],
};

function makeCtx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    sessionId: "test-session",
    question: "top 10 states by sales",
    data: [
      { State: "CA", Sales: 100 },
      { State: "TX", Sales: 200 },
    ],
    summary: baseSummary,
    chatHistory: [],
    mode: "analysis",
    ...overrides,
  };
}

afterEach(() => {
  clearLlmStub();
});

describe("Wave QL1 · runQuickLookupPlanner", () => {
  it("happy path produces a valid QueryPlanBody", async () => {
    let purposeSeen: string | undefined;
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        purposeSeen = LLM_PURPOSE.QUICK_LOOKUP_PLANNER;
        return {
          plan: {
            groupBy: ["State"],
            aggregations: [
              { column: "Sales", operation: "sum", alias: "Total Sales" },
            ],
            sort: [{ column: "Total Sales", direction: "desc" }],
            limit: 10,
          },
          questionRestated: "Top 10 states by Sales",
        };
      },
    });
    const out = await runQuickLookupPlanner(makeCtx(), {
      turnId: "t1",
    });
    assert.ok(out, "expected non-null planner output");
    assert.strictEqual(out.questionRestated, "Top 10 states by Sales");
    assert.deepStrictEqual(out.plan.groupBy, ["State"]);
    assert.strictEqual(out.plan.aggregations?.[0].operation, "sum");
    assert.strictEqual(out.plan.limit, 10);
    assert.strictEqual(purposeSeen, LLM_PURPOSE.QUICK_LOOKUP_PLANNER);
  });

  it("recovers when completeJson's internal repair loop catches a Zod fail", async () => {
    // completeJson owns the 3-attempt repair loop. We only verify that a
    // recovery DID happen (one or more retries fired before success) — the
    // exact attempt count is an internal contract of completeJson, not the
    // planner.
    let calls = 0;
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        calls++;
        if (calls === 1) {
          // Missing required field `questionRestated` → Zod fail
          return { plan: { groupBy: ["State"], limit: 5 } };
        }
        return {
          plan: { groupBy: ["State"], limit: 5 },
          questionRestated: "Top 5 states",
        };
      },
    });
    const out = await runQuickLookupPlanner(makeCtx(), { turnId: "t2" });
    assert.ok(out, "expected recovery via completeJson repair loop");
    assert.ok(calls >= 2, `expected at least 2 LLM calls, got ${calls}`);
    assert.strictEqual(out.questionRestated, "Top 5 states");
  });

  it("terminal Zod fail returns null", async () => {
    let calls = 0;
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        calls++;
        // Always invalid — every attempt fails.
        return { plan: { groupBy: ["State"] }, questionRestated: "x" };
        // ^ questionRestated min(4) fails on every attempt.
      },
    });
    const out = await runQuickLookupPlanner(makeCtx(), { turnId: "t3" });
    assert.strictEqual(out, null);
    // completeJson runs up to 3 attempts internally; we don't assert exact
    // count — only that >= 2 attempts fired (the repair branch ran).
    assert.ok(calls >= 2, `expected at least 2 attempts, got ${calls}`);
  });

  it("LLM throw returns null", async () => {
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: () => {
        throw new Error("synthetic stub failure");
      },
    });
    const out = await runQuickLookupPlanner(makeCtx(), { turnId: "t4" });
    assert.strictEqual(out, null);
  });

  it("includes WIDE-FORMAT shape block in the prompt when dataset was melted", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return {
          plan: {
            groupBy: ["Brand"],
            aggregations: [
              { column: "Value", operation: "sum", alias: "Total Value" },
            ],
            limit: 5,
          },
          questionRestated: "Top 5 brands by Value",
        };
      },
    });
    const wfSummary: DataSummary = {
      ...baseSummary,
      columnCount: 4,
      numericColumns: ["Value"],
      columns: [
        { name: "Brand", type: "string", sampleValues: ["A"] },
        { name: "Period", type: "string", sampleValues: ["Q1 23"] },
        { name: "PeriodIso", type: "string", sampleValues: ["2023-Q1"] },
        { name: "Value", type: "number", sampleValues: [100] },
      ],
      wideFormatTransform: {
        detected: true,
        shape: "pure_period",
        idColumns: ["Brand"],
        meltedColumns: ["Q1 23 Sales", "Q2 23 Sales"],
        periodCount: 2,
        periodColumn: "Period",
        periodIsoColumn: "PeriodIso",
        periodKindColumn: "PeriodKind",
        valueColumn: "Value",
        detectedCurrencySymbol: undefined,
      } as DataSummary["wideFormatTransform"],
    };
    await runQuickLookupPlanner(makeCtx({ summary: wfSummary }), {
      turnId: "t5",
    });
    assert.ok(
      lastUser.includes("DATASET SHAPE"),
      "expected DATASET SHAPE block in user prompt"
    );
    assert.ok(
      lastUser.includes("PeriodIso"),
      "expected PeriodIso mention in user prompt"
    );
  });

  it("includes DIMENSION HIERARCHIES block when the user declared a rollup", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return {
          plan: {
            groupBy: ["Products"],
            aggregations: [
              { column: "Sales", operation: "sum", alias: "Sales" },
            ],
            limit: 10,
          },
          questionRestated: "Top 10 products by Sales",
        };
      },
    });
    const ctx = makeCtx({
      sessionAnalysisContext: {
        dataset: {
          dimensionHierarchies: [
            {
              column: "Products",
              rollupValue: "FEMALE SHOWER GEL",
              source: "user",
            },
          ],
        },
      } as AgentExecutionContext["sessionAnalysisContext"],
    });
    await runQuickLookupPlanner(ctx, { turnId: "t6" });
    assert.ok(
      lastUser.includes("DIMENSION HIERARCHIES"),
      "expected DIMENSION HIERARCHIES block in user prompt"
    );
    assert.ok(
      lastUser.includes("FEMALE SHOWER GEL"),
      "expected rollup value in user prompt"
    );
  });

  describe("Wave B1 · QL1 planner sees user/domain/prior-investigations context", () => {
    it("includes permanentContext (User-provided notes) when set", async () => {
      let lastUser = "";
      installLlmStub({
        [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
          const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
          lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
          return {
            plan: { groupBy: ["State"], aggregations: [{ column: "Sales", operation: "sum", alias: "Sales" }], limit: 10 },
            questionRestated: "Top 10 states by Sales",
          };
        },
      });
      const ctx = makeCtx({
        permanentContext: "always exclude Central region from any rollup; treat 'budget' as cost_cap_eur",
      });
      await runQuickLookupPlanner(ctx, { turnId: "tb1a" });
      assert.ok(
        lastUser.includes("User-provided notes"),
        "expected User-provided notes block in user prompt when permanentContext is set"
      );
      assert.ok(
        lastUser.includes("Central region"),
        "expected the actual note content in user prompt"
      );
    });

    it("includes domainContext (Domain knowledge) when set", async () => {
      let lastUser = "";
      installLlmStub({
        [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
          const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
          lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
          return {
            plan: { groupBy: ["State"], aggregations: [{ column: "Sales", operation: "sum", alias: "Sales" }], limit: 10 },
            questionRestated: "Top 10 states by Sales",
          };
        },
      });
      const ctx = makeCtx({
        domainContext:
          "<<DOMAIN PACK: marico-haircare-portfolio>>\nKey brands: PARACHUTE, NIHAR, SETWET. MAT = Moving Annual Total.\n<</DOMAIN PACK>>",
      });
      await runQuickLookupPlanner(ctx, { turnId: "tb1b" });
      assert.ok(
        lastUser.includes("Domain knowledge"),
        "expected Domain knowledge block in user prompt when domainContext is set"
      );
      assert.ok(
        lastUser.includes("PARACHUTE"),
        "expected the domain pack content to appear in user prompt"
      );
    });

    it("includes prior-investigations block when sessionKnowledge has digests", async () => {
      let lastUser = "";
      installLlmStub({
        [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
          const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
          lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
          return {
            plan: { groupBy: ["State"], aggregations: [{ column: "Sales", operation: "sum", alias: "Sales" }], limit: 5 },
            questionRestated: "Top 5 states by Sales",
          };
        },
      });
      const ctx = makeCtx({
        sessionAnalysisContext: {
          dataset: { columnRoles: [], caveats: [] },
          userIntent: { interpretedConstraints: [] },
          sessionKnowledge: {
            facts: [],
            analysesDone: [],
            priorInvestigations: [
              {
                at: "2026-05-15T10:00:00Z",
                question: "Which brand grew the most in Q1?",
                hypothesesConfirmed: ["PARACHUTE outperformed peers"],
                hypothesesRefuted: [],
                hypothesesOpen: [],
                headlineFinding: "PARACHUTE +12% YoY",
              },
            ],
          },
          suggestedFollowUps: [],
          lastUpdated: { reason: "test", at: "2026-05-15T10:00:00Z" },
          version: 1,
        } as AgentExecutionContext["sessionAnalysisContext"],
      });
      await runQuickLookupPlanner(ctx, { turnId: "tb1c" });
      // formatPriorInvestigationsForPlanner emits a labelled block; check for the brand mention.
      assert.ok(
        lastUser.includes("PARACHUTE"),
        "expected prior-investigation digest to surface in user prompt"
      );
    });

    it("absent context blocks DO NOT leak into the user prompt (clean baseline)", async () => {
      let lastUser = "";
      installLlmStub({
        [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
          const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
          lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
          return {
            plan: { groupBy: ["State"], aggregations: [{ column: "Sales", operation: "sum", alias: "Sales" }], limit: 10 },
            questionRestated: "Top 10 states by Sales",
          };
        },
      });
      const ctx = makeCtx(); // no permanentContext, no domainContext, no SAC
      await runQuickLookupPlanner(ctx, { turnId: "tb1d" });
      assert.ok(
        !lastUser.includes("User-provided notes"),
        "no User-provided notes block when permanentContext absent"
      );
      assert.ok(
        !lastUser.includes("Domain knowledge"),
        "no Domain knowledge block when domainContext absent"
      );
    });

    it("the system prompt mentions user notes / domain knowledge / prior-investigations rules (source-level check)", async () => {
      // System prompt is byte-stable and lives in the module — read directly
      // rather than rely on stub plumbing. This pins the prompt content.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const src = fs.readFileSync(
        path.resolve(here, "..", "lib", "agents", "runtime", "quickAnswerPlanner.ts"),
        "utf8"
      );
      assert.ok(
        src.includes("User-provided notes block"),
        "system prompt should reference the user-notes rule"
      );
      assert.ok(
        src.includes("Domain knowledge block"),
        "system prompt should reference the domain-knowledge rule"
      );
      assert.ok(
        src.includes("Prior investigations block"),
        "system prompt should reference the prior-investigations rule"
      );
    });
  });
});
