import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeCorrelations } from "../lib/correlationAnalyzer.js";
import { buildIdentityGraph } from "../lib/financeMetricAuthority.js";

/**
 * W9 · a correlation that is really an accounting identity (GC% vs its own
 * numerator/denominator) must be dropped BEFORE ranking/charting. When every
 * candidate is definitional, the tool says so via a `structural_identity_filtered`
 * diagnostic — never a chart claiming "GC% is driven by Net Revenue".
 */
function syntheticRows(n: number) {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < n; i++) {
    const nr = 100 + i;
    const cogs = 40 + (i % 7);
    const gc = nr - cogs;
    rows.push({ "Net Revenue": nr, COGS: cogs, GC: gc, "GC%": (gc / nr) * 100 });
  }
  return rows;
}

describe("analyzeCorrelations — structural-identity filter", () => {
  it("drops GC%↔{GC,NR,COGS} and reports structural_identity_filtered when all are definitional", async () => {
    const cols = ["Net Revenue", "COGS", "GC", "GC%"];
    const graph = buildIdentityGraph({ columns: cols });
    const res = await analyzeCorrelations(
      syntheticRows(60),
      "GC%",
      cols,
      "all",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false, // generateCharts off — keep the test offline (no LLM)
      undefined,
      undefined,
      graph,
    );
    assert.equal(res.charts.length, 0);
    assert.equal(res.diagnostic?.reason, "structural_identity_filtered");
    assert.match(res.diagnostic?.notes ?? "", /accounting identit/i);
  });

  it("without an identity graph, the legacy behaviour is unchanged (no filtering)", async () => {
    const cols = ["Net Revenue", "COGS", "GC", "GC%"];
    const res = await analyzeCorrelations(
      syntheticRows(60), "GC%", cols, "all",
      undefined, undefined, undefined, undefined, undefined, false, undefined, undefined,
      // no identityGraph
    );
    assert.notEqual(res.diagnostic?.reason, "structural_identity_filtered");
  });
});
