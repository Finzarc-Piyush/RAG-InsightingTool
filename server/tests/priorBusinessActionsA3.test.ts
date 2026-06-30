import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "../shared/schema.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";

// Stub Azure env so transitive imports don't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { formatPriorBusinessActions } = await import(
  "../lib/agents/runtime/businessActionsAgent.js"
);

function ctxWith(history: Message[]): AgentExecutionContext {
  return { chatHistory: history } as unknown as AgentExecutionContext;
}

function assistantWithActions(
  actions: Array<{ title: string; horizon: "now" | "this_quarter" | "strategic"; confidence: "low" | "medium" | "high" }>
): Message {
  return {
    role: "assistant",
    content: "...",
    timestamp: 1,
    businessActions: actions.map((a) => ({
      title: a.title,
      rationale: "grounded in a finding",
      horizon: a.horizon,
      confidence: a.confidence,
    })),
  } as unknown as Message;
}

describe("A3 · formatPriorBusinessActions", () => {
  it("returns null when no prior assistant turn proposed actions", () => {
    assert.equal(formatPriorBusinessActions(ctxWith([])), null);
    assert.equal(
      formatPriorBusinessActions(ctxWith([{ role: "user", content: "Q", timestamp: 0 } as unknown as Message])),
      null
    );
  });

  it("renders prior actions with horizon + confidence so the agent can advance them", () => {
    const out = formatPriorBusinessActions(
      ctxWith([
        assistantWithActions([
          { title: "Run a metro shelf-share audit", horizon: "now", confidence: "high" },
        ]),
      ])
    );
    assert.ok(out);
    assert.match(out, /\[now\] Run a metro shelf-share audit \(high confidence\)/);
  });

  it("skips intermediate (streaming) assistant rows", () => {
    const out = formatPriorBusinessActions(
      ctxWith([
        {
          role: "assistant",
          content: "streaming…",
          timestamp: 2,
          isIntermediate: true,
          businessActions: [
            { title: "preview action", rationale: "x".repeat(10), horizon: "now", confidence: "low" },
          ],
        } as unknown as Message,
      ])
    );
    assert.equal(out, null);
  });
});
