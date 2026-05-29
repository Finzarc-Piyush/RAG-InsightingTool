/**
 * Wave W-GMK3 · drift-defence: the visual-planner deterministic fallback
 * MUST share the same x-axis selector as `chartFromTable.ts`. Both paths
 * can build a chart from `ctx.lastAnalyticalTable` — if they diverge,
 * the same result-table produces two incoherent charts depending on
 * which path fires for the turn.
 *
 * Pinned via source inspection (no full ctx mock needed). If a refactor
 * removes the `resolvePeriodAxis` import or the call site, this test
 * surfaces the drift before the deterministic fallback silently reverts
 * to the dumb `dimCols[0]!` rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../lib/agents/runtime/visualPlanner.ts"),
  "utf8"
);

describe("W-GMK3 · visualPlanner parity with chartFromTable's period resolver", () => {
  it("imports resolvePeriodAxis from the shared helper module", () => {
    assert.match(
      src,
      /from\s+"\.\.\/\.\.\/periodColumnResolver\.js"/,
      "visualPlanner.ts must import from server/lib/periodColumnResolver.ts"
    );
    assert.match(src, /\bresolvePeriodAxis\b/);
  });

  it("calls resolvePeriodAxis with (columns, sample, ctx.summary, ctx.question)", () => {
    assert.match(
      src,
      /resolvePeriodAxis\(\s*columns\s*,\s*sample\s*,\s*ctx\.summary\s*,\s*ctx\.question\s*\)/
    );
  });

  it("applies the injected PeriodKind filter before compileChartSpec", () => {
    // The filter loop must rebind `workingRows` from the picker's
    // injectedFilter before the chart compile call uses it.
    assert.match(
      src,
      /periodAxis\.injectedFilter[\s\S]*?workingRows\s*=\s*filtered/
    );
    assert.match(src, /compileChartSpec\(\s*workingRows\b/);
    assert.match(src, /processChartData\(\s*workingRows\b/);
  });

  it("forwards axisReason into the chart spec when present", () => {
    assert.match(src, /\.\.\.\(axisReason\s*\?\s*\{\s*axisReason\s*\}\s*:\s*\{\}\)/);
  });

  it("does NOT use the pre-wave `const x = dimCols[0]!` rule unconditionally", () => {
    // The old single line must be gone — replaced by the resolver branch.
    assert.doesNotMatch(src, /^\s*const x = dimCols\[0\]!;\s*$/m);
  });

  it("falls back to cardinality-pruning when no period column is present", () => {
    assert.match(src, /distinct\.size\s*>=\s*2/);
    assert.match(src, /usableDim/);
  });
});
