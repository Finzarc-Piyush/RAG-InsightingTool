import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInformationSeekingQuery,
  isAnalyticalQuery,
} from "../lib/analyticalQueryEngine.js";

/**
 * Regression guard for the columnar-flag propagation fix in
 * services/chat/answerQuestionContext.ts.
 *
 * Pure-imperative dashboard COMMANDS like "give a pjp dashboard." match NEITHER
 * query-shape heuristic. The old code set the agent's `columnarStoragePath`
 * flag (→ ctx.exec.columnarStoragePath) only inside `if (useDuckDBPlan)`, and
 * useDuckDBPlan requires one of these heuristics to match. So these commands
 * left the flag undefined and every aggregation step hard-failed with "DuckDB
 * execution surface is not available" — even though the data was materialized.
 *
 * The fix derives the flag from materialization state directly, independent of
 * the message. This test pins the underlying fact (these commands match neither
 * heuristic) so that anyone tempted to re-gate the columnar flag on the
 * query-shape heuristics sees exactly why that re-breaks dashboard commands.
 *
 * NOTE: phrasings containing "for" (e.g. "build a dashboard for sales") DO match
 * isAnalyticalQuery and so were never affected — the bug is specific to the
 * neither-matches phrasings asserted below.
 */
const NEITHER_MATCHES_COMMANDS = [
  "give a pjp dashboard.",
  "make me a dashboard",
  "make a pjp dashboard",
];

test("pure-imperative dashboard commands match neither query-shape heuristic", () => {
  for (const q of NEITHER_MATCHES_COMMANDS) {
    assert.equal(
      isInformationSeekingQuery(q),
      false,
      `isInformationSeekingQuery should be false for: ${q}`
    );
    assert.equal(
      isAnalyticalQuery(q),
      false,
      `isAnalyticalQuery should be false for: ${q}`
    );
  }
});
