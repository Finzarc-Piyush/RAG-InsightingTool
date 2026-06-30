import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAccountingIdentitiesBlock } from "../lib/agents/runtime/context.js";
import { buildIdentityGraph } from "../lib/financeMetricAuthority.js";

/**
 * W8 · the deterministic ACCOUNTING IDENTITIES prompt block (shipped WITH the
 * permission, L-022). It must name the definitional pairs in THIS dataset and
 * the correlation≠causation rule — and stay empty for a non-finance dataset.
 */
describe("formatAccountingIdentitiesBlock", () => {
  it("lists the GC%↔NR definitional pair and the rules", () => {
    const cols = ["Channel", "GC", "Net Revenue", "COGS", "GC%", "A&P Spend"];
    const graph = buildIdentityGraph({ columns: cols });
    const block = formatAccountingIdentitiesBlock(graph, cols);
    assert.match(block, /ACCOUNTING IDENTITIES/);
    assert.match(block, /"GC%" and "Net Revenue"|"Net Revenue" and "GC%"/);
    assert.match(block, /TAUTOLOGY/);
    assert.match(block, /CORRELATION ≠ CAUSATION/);
  });

  it("is empty for a dataset with no structurally-related columns", () => {
    const cols = ["Region", "Salesperson", "Visits", "Store Count"];
    const graph = buildIdentityGraph({ columns: cols });
    assert.equal(formatAccountingIdentitiesBlock(graph, cols), "");
  });
});
