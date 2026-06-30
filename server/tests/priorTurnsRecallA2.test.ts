import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "../shared/schema.js";

// Stub Azure env so transitive imports don't crash at module load.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { formatPriorTurnsForPrompt } = await import(
  "../lib/agents/runtime/priorTurnState.js"
);

/** Minimal assistant message carrying a finalised blackboard snapshot. */
function assistantMsg(
  content: string,
  findings: Array<{
    id?: string;
    label: string;
    detail?: string;
    significance: "routine" | "notable" | "anomalous";
    relatedColumns?: string[];
  }>
): Message {
  return {
    role: "assistant",
    content,
    timestamp: 1,
    agentInternals: { blackboardSnapshot: { findings } },
  } as unknown as Message;
}

function userMsg(content: string): Message {
  return { role: "user", content, timestamp: 0 } as unknown as Message;
}

describe("A2 · formatPriorTurnsForPrompt (multi-turn structured recall)", () => {
  it("returns '' when there is no finalised assistant turn", () => {
    assert.equal(formatPriorTurnsForPrompt([]), "");
    assert.equal(formatPriorTurnsForPrompt(undefined), "");
    assert.equal(formatPriorTurnsForPrompt([userMsg("just a question")]), "");
  });

  it("emits a labelled block with the user's question and finding ids", () => {
    const history: Message[] = [
      userMsg("How is GT doing vs Q-com?"),
      assistantMsg("...", [
        { id: "F1", label: "GT leads", detail: "GT volume 412 MT, 10x Q-com", significance: "notable", relatedColumns: ["Channel", "Volume"] },
      ]),
    ];
    const block = formatPriorTurnsForPrompt(history);
    assert.match(block, /^### PRIOR_TURN_STATE/);
    assert.match(block, /Q: How is GT doing vs Q-com\?/);
    assert.match(block, /F1 \[notable\] GT volume 412 MT, 10x Q-com \(cols: Channel, Volume\)/);
  });

  it("recalls MORE than the latest turn (the core A2 fix) and caps at maxTurns", () => {
    const history: Message[] = [];
    for (let t = 1; t <= 5; t++) {
      history.push(userMsg(`Q${t}`));
      history.push(assistantMsg(`A${t}`, [
        { id: `F${t}`, label: `finding ${t}`, significance: "anomalous" },
      ]));
    }
    const block = formatPriorTurnsForPrompt(history, 3);
    // Latest three turns (Q5, Q4, Q3) present; older ones dropped.
    assert.match(block, /Q: Q5/);
    assert.match(block, /Q: Q4/);
    assert.match(block, /Q: Q3/);
    assert.doesNotMatch(block, /Q: Q2/);
    assert.doesNotMatch(block, /Q: Q1/);
  });

  it("ranks anomalous/notable findings ahead of routine and caps per turn", () => {
    const history: Message[] = [
      userMsg("Q"),
      assistantMsg("A", [
        { id: "R1", label: "routine a", significance: "routine" },
        { id: "A1", label: "anomalous one", significance: "anomalous" },
        { id: "N1", label: "notable one", significance: "notable" },
        { id: "R2", label: "routine b", significance: "routine" },
        { id: "R3", label: "routine c", significance: "routine" },
      ]),
    ];
    const block = formatPriorTurnsForPrompt(history);
    // Anomalous first, then notable; only 4 of 5 findings rendered.
    const idxAnom = block.indexOf("A1 [anomalous]");
    const idxNotable = block.indexOf("N1 [notable]");
    assert.ok(idxAnom > -1 && idxNotable > idxAnom);
    assert.doesNotMatch(block, /R3 \[routine\]/); // 5th finding dropped by cap
  });

  it("skips intermediate (streaming preview) assistant rows", () => {
    const history: Message[] = [
      userMsg("Q"),
      {
        role: "assistant",
        content: "streaming…",
        timestamp: 2,
        isIntermediate: true,
        agentInternals: { blackboardSnapshot: { findings: [{ id: "X", label: "preview", significance: "notable" }] } },
      } as unknown as Message,
    ];
    assert.equal(formatPriorTurnsForPrompt(history), "");
  });
});
