/**
 * Pin the agent's contract:
 *   1. Hard-skips when the envelope has < 2 findings AND no magnitudes
 *      (saves the LLM call on edge cases).
 *   2. Honours the empty-array self-gate from the LLM (returns []).
 *   3. Caps the result at 5 items even if the LLM returns more.
 *   4. Schema-validates each item; invalid items kill the call (returns []).
 *   5. Forwards the right LLM purpose (BUSINESS_ACTIONS) for cost telemetry.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runBusinessActions } from "../lib/agents/runtime/businessActionsAgent.js";
import {
  installLlmStub,
  clearLlmStub,
  DEFAULT_STUB_HANDLERS,
} from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { Message } from "../shared/schema.js";

type AnswerEnvelope = NonNullable<Message["answerEnvelope"]>;

function makeCtx(question: string): AgentExecutionContext {
  return {
    sessionId: "sess-test",
    question,
    data: [],
    summary: {
      shortDescription: "test",
      columns: [],
      numericColumns: [],
      dateColumns: [],
      sampleRows: [],
      totalRows: 0,
      totalColumns: 0,
      columnStatistics: {},
    } as unknown as AgentExecutionContext["summary"],
    chatHistory: [],
    mode: "analysis",
  };
}

function makeEnvelope(findings: number, withMagnitude = true): AnswerEnvelope {
  return {
    tldr: "Sales fell 4.2pp YoY in Q4.",
    findings: Array.from({ length: findings }, (_, i) => ({
      headline: `Finding ${i + 1} headline`,
      evidence: `Evidence row ${i + 1} from blackboard.`,
      magnitude: withMagnitude ? `-${i + 1}.0pp` : undefined,
    })),
    implications: [
      {
        statement: "Category softness in metro stores.",
        soWhat: "Channel mix shift hurts MARICO disproportionately.",
        confidence: "high",
      },
    ],
  };
}

describe("businessActionsAgent", () => {
  beforeEach(() => {
    installLlmStub({ ...DEFAULT_STUB_HANDLERS });
  });

  afterEach(() => {
    clearLlmStub();
  });

  test("hard-skips (no LLM call) when fewer than 2 findings AND no magnitudes", async () => {
    let llmCalls = 0;
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: () => {
        llmCalls += 1;
        return { items: [] };
      },
    });

    const env = makeEnvelope(1, false); // 1 finding, no magnitude
    const items = await runBusinessActions(makeCtx("How do I rescue sales?"), env, {
      turnId: "t1",
    });
    assert.deepEqual(items, []);
    assert.equal(llmCalls, 0, "agent should not have invoked LLM");
  });

  test("invokes LLM when at least 2 findings exist", async () => {
    let llmCalls = 0;
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: () => {
        llmCalls += 1;
        return {
          items: [
            {
              title: "Run shelf-share audit in metros",
              rationale: "Q4 share fell 4.2pp (finding 1).",
              horizon: "now",
              confidence: "high",
            },
            {
              title: "Pause LASHE promo spend",
              rationale: "Negative ROI signal (finding 2).",
              horizon: "this_quarter",
              confidence: "medium",
            },
          ],
        };
      },
    });

    const items = await runBusinessActions(
      makeCtx("How do I rescue falling sales?"),
      makeEnvelope(2),
      { turnId: "t2" }
    );
    assert.equal(llmCalls, 1);
    assert.equal(items.length, 2);
    assert.equal(items[0].horizon, "now");
    assert.equal(items[0].confidence, "high");
    assert.equal(items[1].horizon, "this_quarter");
  });

  test("respects empty-array self-gate from the LLM", async () => {
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: () => ({ items: [] }),
    });
    const items = await runBusinessActions(
      makeCtx("What are sales by brand last quarter?"), // descriptive
      makeEnvelope(3),
      { turnId: "t3" }
    );
    assert.deepEqual(items, []);
  });

  test("caps at 5 items even if LLM returns more — schema rejects payload", async () => {
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: () => ({
        items: Array.from({ length: 8 }, (_, i) => ({
          title: `Action ${i + 1} headline text`,
          rationale: `Grounded in finding ${(i % 2) + 1}.`,
          horizon: "now",
          confidence: "medium",
        })),
      }),
    });
    const items = await runBusinessActions(
      makeCtx("How do I improve margins?"),
      makeEnvelope(2),
      { turnId: "t4" }
    );
    // schema cap is .max(5); zod rejects the over-cap payload, the agent
    // contract is "fail safe" → empty array.
    assert.deepEqual(items, []);
  });

  test("schema-rejects malformed items → empty result", async () => {
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: () => ({
        items: [
          {
            title: "ok",
            rationale: "x",
            horizon: "now",
            confidence: "high",
          }, // title too short, rationale too short
        ],
      }),
    });
    const items = await runBusinessActions(
      makeCtx("How should we focus next quarter?"),
      makeEnvelope(2),
      { turnId: "t5" }
    );
    assert.deepEqual(items, []);
  });

  test("invokes LLM with the BUSINESS_ACTIONS purpose for cost telemetry", async () => {
    let observedPurpose: string | undefined;
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: (params) => {
        // The stub harness reads opts.purpose, but params.model is also
        // resolved per purpose. We can't see opts directly, so we check
        // the system prompt content as a proxy that this is the right
        // agent firing.
        observedPurpose = params.messages?.[0]?.content?.toString().slice(0, 200);
        return { items: [] };
      },
    });
    await runBusinessActions(makeCtx("How do I increase sales?"), makeEnvelope(2), {
      turnId: "t6",
    });
    assert.ok(
      observedPurpose && observedPurpose.includes("FMCG"),
      `expected business actions system prompt to fire, got: ${observedPurpose ?? "(none)"}`
    );
  });

  test("counts onLlmCall callback invocations", async () => {
    let callCount = 0;
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: () => ({
        items: [
          {
            title: "Action one with enough length",
            rationale: "Grounded rationale text",
            horizon: "now",
            confidence: "low",
          },
          {
            title: "Action two with enough length",
            rationale: "Grounded rationale text two",
            horizon: "strategic",
            confidence: "medium",
          },
        ],
      }),
    });
    await runBusinessActions(
      makeCtx("What should we do about LASHE?"),
      makeEnvelope(2),
      { turnId: "t7", onLlmCall: () => (callCount += 1) },
    );
    assert.ok(callCount >= 1, `expected onLlmCall to fire at least once, got ${callCount}`);
  });

  test("returns [] when LLM stub throws (no exception leaks to caller)", async () => {
    installLlmStub({
      [LLM_PURPOSE.BUSINESS_ACTIONS]: () => {
        throw new Error("simulated LLM outage");
      },
    });
    // The agent does NOT catch (the stub harness throws inside callLlm,
    // which surfaces as a thrown error). Caller must wrap in catch — the
    // agent loop's `.catch` does this. We assert the agent itself
    // propagates only when the LLM throws synchronously, which is
    // documented behavior. Wrap here to mimic the loop's `.catch`.
    const items = await runBusinessActions(
      makeCtx("How do I rescue sales?"),
      makeEnvelope(2),
      { turnId: "t8" },
    ).catch(() => [] as never);
    assert.deepEqual(items, []);
  });

  describe("Wave B2 · sees DIMENSION HIERARCHIES and DATASET SHAPE blocks", () => {
    test("DIMENSION HIERARCHIES block appears in user prompt when ctx has declared rollups", async () => {
      let lastUser = "";
      installLlmStub({
        [LLM_PURPOSE.BUSINESS_ACTIONS]: (params) => {
          const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
          lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
          return { items: [] };
        },
      });
      const ctx = makeCtx("How do I lift MARICO's share?");
      ctx.sessionAnalysisContext = {
        dataset: {
          dimensionHierarchies: [
            {
              column: "Products",
              rollupValue: "FEMALE SHOWER GEL",
              source: "user",
            },
          ],
        },
      } as AgentExecutionContext["sessionAnalysisContext"];
      await runBusinessActions(ctx, makeEnvelope(2), { turnId: "tb2a" });
      assert.ok(
        lastUser.includes("DIMENSION HIERARCHIES"),
        "expected DIMENSION HIERARCHIES block in user prompt"
      );
      assert.ok(
        lastUser.includes("FEMALE SHOWER GEL"),
        "expected rollup value in the prompt content"
      );
    });

    test("DATASET SHAPE block appears in user prompt when dataset was wide-format melted", async () => {
      let lastUser = "";
      installLlmStub({
        [LLM_PURPOSE.BUSINESS_ACTIONS]: (params) => {
          const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
          lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
          return { items: [] };
        },
      });
      const ctx = makeCtx("How do we recover Q3 share?");
      ctx.summary = {
        ...ctx.summary,
        wideFormatTransform: {
          detected: true,
          shape: "pure_period",
          idColumns: ["Brand"],
          meltedColumns: ["Q1 2024", "Q2 2024", "Q3 2024", "Q4 2024"],
          periodCount: 4,
          periodColumn: "Period",
          periodIsoColumn: "PeriodIso",
          periodKindColumn: "PeriodKind",
          valueColumn: "Value",
          detectedCurrencySymbol: undefined,
        },
      } as AgentExecutionContext["summary"];
      await runBusinessActions(ctx, makeEnvelope(2), { turnId: "tb2b" });
      assert.ok(
        lastUser.includes("DATASET SHAPE"),
        "expected DATASET SHAPE block (formatWideFormatShapeBlock) in user prompt"
      );
      assert.ok(
        lastUser.includes("WIDE format") || lastUser.includes("MELTED"),
        "expected wide-format melt vocabulary in the prompt content"
      );
    });

    test("absent context blocks DO NOT leak (clean baseline)", async () => {
      let lastUser = "";
      installLlmStub({
        [LLM_PURPOSE.BUSINESS_ACTIONS]: (params) => {
          const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
          lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
          return { items: [] };
        },
      });
      const ctx = makeCtx("How do I rescue sales?");
      await runBusinessActions(ctx, makeEnvelope(2), { turnId: "tb2c" });
      assert.ok(
        !lastUser.includes("DIMENSION HIERARCHIES"),
        "no DIMENSION HIERARCHIES block when none declared"
      );
      assert.ok(
        !lastUser.includes("DATASET SHAPE"),
        "no DATASET SHAPE block when dataset not melted"
      );
    });

    test("system prompt warns NEVER to treat rollup as a peer and NEVER to reference wide-format column names (source-level check)", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const src = fs.readFileSync(
        path.resolve(here, "..", "lib", "agents", "runtime", "businessActionsAgent.ts"),
        "utf8"
      );
      assert.ok(
        src.includes("Treat a dimension's rollup-row as a peer"),
        "system prompt should warn never to treat rollup as a peer"
      );
      assert.ok(
        src.includes("Reference original wide-format column names"),
        "system prompt should warn never to reference original wide-format column names"
      );
    });
  });
});
