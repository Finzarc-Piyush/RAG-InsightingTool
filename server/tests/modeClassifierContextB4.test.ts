import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { classifyMode } from "../lib/agents/modeClassifier.js";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { DataSummary, Message } from "../shared/schema.js";

/**
 * Wave B4 · Pins that `classifyMode` accepts and threads the four
 * optional context blocks (permanentContext, domainContext,
 * userIntentVerbatim, userIntentConstraints) into the LLM prompt.
 *
 * Pre-B4 the classifier saw only the question + recent chat history +
 * the columns list. Ambiguous short follow-ups ("yes do it",
 * "use MAT for that") couldn't be resolved when the user's stated
 * intent or domain vocabulary was already in the session — the
 * classifier would surface-form regex-match and frequently mis-route.
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

const emptyHistory: Message[] = [];

afterEach(() => {
  clearLlmStub();
});

describe("Wave B4 · classifyMode threads optional context blocks", () => {
  it("permanentContext appears in the LLM prompt when provided", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.MODE_CLASSIFY]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return { mode: "analysis", confidence: 0.9 };
      },
    });
    await classifyMode("what's the total revenue?", emptyHistory, baseSummary, undefined, {
      permanentContext:
        "treat 'budget' as cost_cap_eur for this session; always exclude Central region",
    });
    assert.ok(
      lastUser.includes("USER NOTES"),
      `expected USER NOTES block in classifier prompt; got: ${lastUser.slice(0, 300)}`
    );
    assert.ok(
      lastUser.includes("cost_cap_eur"),
      "expected permanent-context content to appear in prompt"
    );
  });

  it("domainContext appears in the LLM prompt when provided", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.MODE_CLASSIFY]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return { mode: "analysis", confidence: 0.9 };
      },
    });
    await classifyMode("compute MAT for PARACHUTE", emptyHistory, baseSummary, undefined, {
      domainContext:
        "<<DOMAIN PACK: marico-haircare>>\nMAT = Moving Annual Total (sum over a 52-week rolling window)\n<</DOMAIN PACK>>",
    });
    assert.ok(
      lastUser.includes("DOMAIN VOCABULARY"),
      "expected DOMAIN VOCABULARY block in classifier prompt"
    );
    assert.ok(
      lastUser.includes("Moving Annual Total"),
      "expected domain-pack content in prompt"
    );
  });

  it("userIntent (verbatim + constraints) appears in the LLM prompt when provided", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.MODE_CLASSIFY]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return { mode: "modeling", confidence: 0.85 };
      },
    });
    await classifyMode("yes", emptyHistory, baseSummary, undefined, {
      userIntentVerbatim: "I'm building a polynomial regression model for PA TOM",
      userIntentConstraints: ["use all numeric features", "5-fold cross-validation"],
    });
    assert.ok(
      lastUser.includes("USER INTENT"),
      "expected USER INTENT block in classifier prompt"
    );
    assert.ok(
      lastUser.includes("polynomial regression"),
      "expected user-intent verbatim text in prompt"
    );
    assert.ok(
      lastUser.includes("cross-validation"),
      "expected interpreted constraint in prompt"
    );
  });

  it("ABSENT context blocks DO NOT leak (clean baseline)", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.MODE_CLASSIFY]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return { mode: "analysis", confidence: 0.9 };
      },
    });
    await classifyMode("show me top brands by sales", emptyHistory, baseSummary);
    assert.ok(
      !lastUser.includes("USER NOTES"),
      "no USER NOTES block when permanentContext absent"
    );
    assert.ok(
      !lastUser.includes("DOMAIN VOCABULARY"),
      "no DOMAIN VOCABULARY block when domainContext absent"
    );
    assert.ok(
      !lastUser.includes("USER INTENT"),
      "no USER INTENT block when userIntent absent"
    );
  });

  it("backwards-compat: omitting the context arg still routes (pre-B4 signature)", async () => {
    installLlmStub({
      [LLM_PURPOSE.MODE_CLASSIFY]: () => ({
        mode: "dataOps",
        confidence: 0.92,
      }),
    });
    const result = await classifyMode("add a column profit = revenue - cost", emptyHistory, baseSummary);
    assert.equal(result.mode, "dataOps");
    assert.ok(result.confidence >= 0.9);
  });

  it("all four blocks together — pre-prompt is still well-formed", async () => {
    let lastUser = "";
    installLlmStub({
      [LLM_PURPOSE.MODE_CLASSIFY]: (params) => {
        const msgs = (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastUser = msgs.find((m) => m.role === "user")?.content ?? "";
        return { mode: "analysis", confidence: 0.9 };
      },
    });
    await classifyMode("yes do it", emptyHistory, baseSummary, undefined, {
      permanentContext: "exclude Central region",
      domainContext: "MAT = Moving Annual Total",
      userIntentVerbatim: "I'm exploring sales by region",
      userIntentConstraints: ["focus on Q3 only"],
    });
    assert.ok(lastUser.includes("USER NOTES"));
    assert.ok(lastUser.includes("DOMAIN VOCABULARY"));
    assert.ok(lastUser.includes("USER INTENT"));
    // Ensure blocks are separated by blank lines (each starts with \n\n).
    const userIdx = lastUser.indexOf("USER NOTES");
    const domainIdx = lastUser.indexOf("DOMAIN VOCABULARY");
    const intentIdx = lastUser.indexOf("USER INTENT");
    assert.ok(userIdx > 0 && domainIdx > userIdx && intentIdx > userIdx);
  });
});
