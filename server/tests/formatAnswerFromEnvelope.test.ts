// Pins the key-insight dedup: `formatAnswerFromEnvelope` must NOT append a
// "**Key insight:**" suffix to the answer body. The key insight is surfaced
// exactly once — in the "Key Insights" section (InsightCard, fed by
// appendEnvelopeInsight). Appending it to the body produced a visible
// duplicate (the bolded line in the answer block AND the same sentence again
// in Key Insights), which this guard prevents from regressing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAnswerFromEnvelope } from "../lib/agents/runtime/agentLoopFormatters.js";

test("formatAnswerFromEnvelope returns the trimmed body", () => {
  assert.equal(
    formatAnswerFromEnvelope("  Females survived at 74.2%.  "),
    "Females survived at 74.2%."
  );
});

test("does NOT append a 'Key insight:' suffix even when a key insight is supplied", () => {
  const out = formatAnswerFromEnvelope(
    "Females survived at 74.2% versus 18.9% for males.",
    "The sex gap is large enough to matter for any follow-on cut."
  );
  assert.ok(!out.includes("Key insight"), `expected no key-insight suffix, got: ${out}`);
  assert.equal(out, "Females survived at 74.2% versus 18.9% for males.");
});

test("ignores a null/undefined key insight", () => {
  assert.equal(formatAnswerFromEnvelope("Body.", null), "Body.");
  assert.equal(formatAnswerFromEnvelope("Body.", undefined), "Body.");
});
