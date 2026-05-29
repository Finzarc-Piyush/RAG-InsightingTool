// Wave W-UD7 · pins the promptBudget allocator's invariants:
//   - reserved slots are returned verbatim (never trimmed)
//   - when total fits, blocks pass through unchanged
//   - when over-budget, slots are trimmed in priorityOrder
//   - hard caps short-circuit before budget logic
//   - `applyCap` reports a TrimmedBlockInfo iff truncation occurred
//   - `formatContextTrimmedPayload` returns undefined for the empty case

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROMPT_BUDGET,
  applyCap,
  applyFlexible,
  flexibleBudget,
  formatContextTrimmedPayload,
  type PromptBudget,
} from "../lib/agents/runtime/promptBudget.js";

function budgetFor(opts: Partial<PromptBudget>): PromptBudget {
  return {
    total: opts.total ?? 100,
    reserved: opts.reserved ?? { directives: 20, instructions: 10, schema: 20 },
    flexible: opts.flexible ?? { rag: 25, blackboard: 15, history: 10 },
  };
}

test("flexibleBudget = total minus the reserved sum", () => {
  const b = budgetFor({});
  assert.equal(flexibleBudget(b), 100 - (20 + 10 + 20));
});

test("flexibleBudget collapses to 0 (not negative) when reserved overruns total", () => {
  const b = budgetFor({
    total: 30,
    reserved: { directives: 20, instructions: 20, schema: 20 },
  });
  assert.equal(flexibleBudget(b), 0);
});

test("applyFlexible — under budget passes through unchanged", () => {
  const b = budgetFor({});
  const res = applyFlexible({
    budget: b,
    blocks: [
      { id: "rag", slot: "rag", content: "x".repeat(20) },
      { id: "bb", slot: "blackboard", content: "y".repeat(10) },
    ],
  });
  assert.equal(res.outputs.length, 2);
  assert.equal(res.outputs[0]!.content.length, 20);
  assert.equal(res.outputs[1]!.content.length, 10);
  assert.equal(res.trimmedBlocks.length, 0);
});

test("applyFlexible — over budget trims `rag` first, leaves later slots untouched", () => {
  // Flexible budget = 100 - 50 = 50. Blocks sum to 60 → 10 chars must be cut.
  const b = budgetFor({});
  const res = applyFlexible({
    budget: b,
    blocks: [
      { id: "rag", slot: "rag", content: "r".repeat(40) },
      { id: "bb", slot: "blackboard", content: "b".repeat(10) },
      { id: "hist", slot: "history", content: "h".repeat(10) },
    ],
  });
  assert.equal(res.totalFlexibleChars, 50);
  // `rag` shrank, `blackboard` and `history` are untouched (priority order).
  assert.equal(res.outputs[0]!.content.length, 30);
  assert.equal(res.outputs[1]!.content.length, 10);
  assert.equal(res.outputs[2]!.content.length, 10);
  assert.equal(res.trimmedBlocks.length, 1);
  assert.equal(res.trimmedBlocks[0]!.id, "rag");
  assert.equal(res.trimmedBlocks[0]!.inputChars, 40);
  assert.equal(res.trimmedBlocks[0]!.outputChars, 30);
});

test("applyFlexible — when rag is exhausted, the cut spills into blackboard, history untouched if not needed", () => {
  // Flexible budget = 50. Blocks sum to 100, overshoot = 50.
  // Step 1: rag (40 chars) → all 40 cut, overshoot reduces to 10.
  // Step 2: blackboard (40 chars) → 10 more cut, overshoot reduces to 0.
  // Step 3: history (20 chars) → loop exits, history untouched.
  const b = budgetFor({});
  const res = applyFlexible({
    budget: b,
    blocks: [
      { id: "rag", slot: "rag", content: "r".repeat(40) },
      { id: "bb", slot: "blackboard", content: "b".repeat(40) },
      { id: "hist", slot: "history", content: "h".repeat(20) },
    ],
  });
  assert.equal(res.totalFlexibleChars, 50);
  assert.equal(res.outputs[0]!.content.length, 0);
  assert.equal(res.outputs[1]!.content.length, 30);
  assert.equal(res.outputs[2]!.content.length, 20);
  // Only rag and blackboard show up as trimmed; history was untouched.
  assert.equal(res.trimmedBlocks.length, 2);
  const ids = res.trimmedBlocks.map((b) => b.id).sort();
  assert.deepEqual(ids, ["bb", "rag"]);
});

test("applyFlexible — when rag+blackboard can't absorb the overshoot, history is also trimmed", () => {
  // Flexible budget = 50.
  // rag=10, blackboard=10, history=80 → total 100, overshoot = 50.
  // rag absorbs 10 → 0. blackboard absorbs 10 → 0. history must absorb 30.
  const b = budgetFor({});
  const res = applyFlexible({
    budget: b,
    blocks: [
      { id: "rag", slot: "rag", content: "r".repeat(10) },
      { id: "bb", slot: "blackboard", content: "b".repeat(10) },
      { id: "hist", slot: "history", content: "h".repeat(80) },
    ],
  });
  assert.equal(res.outputs[0]!.content.length, 0);
  assert.equal(res.outputs[1]!.content.length, 0);
  assert.equal(res.outputs[2]!.content.length, 50);
  assert.equal(res.trimmedBlocks.length, 3);
});

test("applyFlexible — multi-block within one slot trims proportionally", () => {
  // Two RAG blocks, one big + one small. Both should shrink; the big one
  // shrinks more.
  const b = budgetFor({
    total: 100,
    reserved: { directives: 20, instructions: 10, schema: 20 },
    flexible: { rag: 50, blackboard: 0, history: 0 },
  });
  const res = applyFlexible({
    budget: b,
    blocks: [
      { id: "rag-big", slot: "rag", content: "B".repeat(80) },
      { id: "rag-small", slot: "rag", content: "s".repeat(20) },
    ],
  });
  // Budget = 50; overshoot = 50; reduction is proportional.
  assert.equal(res.totalFlexibleChars, 50);
  assert.ok(res.outputs[0]!.content.length > res.outputs[1]!.content.length);
});

test("applyFlexible — respects per-block hardCaps before budget trim", () => {
  const b = budgetFor({});
  const res = applyFlexible({
    budget: b,
    blocks: [
      { id: "rag", slot: "rag", content: "x".repeat(200) },
    ],
    hardCaps: { rag: 30 },
  });
  // After hard-cap rag is 30, well under the 50-char flexible budget.
  assert.equal(res.outputs[0]!.content.length, 30);
  assert.equal(res.trimmedBlocks.length, 1);
  assert.equal(res.trimmedBlocks[0]!.id, "rag");
});

test("applyFlexible — custom priorityOrder swaps trim order", () => {
  const b = budgetFor({});
  // Same setup as the first over-budget test but with history-first.
  const res = applyFlexible({
    budget: b,
    blocks: [
      { id: "rag", slot: "rag", content: "r".repeat(40) },
      { id: "hist", slot: "history", content: "h".repeat(20) },
    ],
    priorityOrder: ["history", "blackboard", "rag"],
  });
  // 60 total, budget 50 → reduce 10 from history first.
  assert.equal(res.outputs[0]!.content.length, 40);
  assert.equal(res.outputs[1]!.content.length, 10);
  assert.equal(res.trimmedBlocks[0]!.id, "hist");
});

test("applyCap — under-cap value passes through with no trimmed info", () => {
  const result = applyCap("notes", "abc", 100);
  assert.equal(result.content, "abc");
  assert.equal(result.trimmed, undefined);
});

test("applyCap — over-cap value truncated and trimmed info populated", () => {
  const result = applyCap("notes", "a".repeat(150), 100);
  assert.equal(result.content.length, 100);
  assert.equal(result.trimmed?.id, "notes");
  assert.equal(result.trimmed?.inputChars, 150);
  assert.equal(result.trimmed?.outputChars, 100);
  assert.equal(result.trimmed?.reason, "budget");
});

test("applyCap — null/undefined input coerces to empty string", () => {
  assert.equal(applyCap("x", undefined, 100).content, "");
  assert.equal(applyCap("x", null, 100).content, "");
  // Both pass-through, no trim.
  assert.equal(applyCap("x", undefined, 100).trimmed, undefined);
});

test("formatContextTrimmedPayload — empty rows returns undefined", () => {
  assert.equal(formatContextTrimmedPayload([]), undefined);
});

test("formatContextTrimmedPayload — non-empty rows wrapped into { blocks }", () => {
  const payload = formatContextTrimmedPayload([
    { id: "a", inputChars: 10, outputChars: 5, reason: "budget" },
  ]);
  assert.ok(payload);
  assert.equal(payload!.blocks.length, 1);
  assert.equal(payload!.blocks[0]!.id, "a");
});

test("DEFAULT_PROMPT_BUDGET — directives + instructions + schema fit under total", () => {
  const b = DEFAULT_PROMPT_BUDGET;
  const reservedTotal =
    b.reserved.directives + b.reserved.instructions + b.reserved.schema;
  assert.ok(reservedTotal < b.total, `${reservedTotal} should be < ${b.total}`);
  assert.ok(flexibleBudget(b) > 0);
});
