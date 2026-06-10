/**
 * Wave MW5 · org-average reference line on categorical breakdowns. The client
 * resolves `value: "mean"` itself, so the benchmark always matches the tile.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachOrgAverageReferenceLines } from "../lib/agents/runtime/attachReferenceLines.js";
import type { ChartSpec } from "../shared/schema.js";

function bar(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    type: "bar",
    title: "PJP Adherence rate by ASM",
    x: "ASM",
    y: "PJP Adherence_rate",
    data: [
      { ASM: "A", "PJP Adherence_rate": 0.9 },
      { ASM: "B", "PJP Adherence_rate": 0.6 },
      { ASM: "C", "PJP Adherence_rate": 0.4 },
    ],
    ...over,
  } as ChartSpec;
}

describe("MW5 · attachOrgAverageReferenceLines", () => {
  it("adds an 'Org avg' mean reference line to a categorical bar breakdown", () => {
    const [out] = attachOrgAverageReferenceLines([bar()]);
    const refs = (out._autoLayers ?? []).filter((l) => l.type === "reference-line");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].on, "y");
    assert.equal(refs[0].value, "mean");
    assert.equal(refs[0].label, "Org avg");
  });

  it("does not mutate the input chart (chat-surface charts unaffected)", () => {
    const input = bar();
    attachOrgAverageReferenceLines([input]);
    assert.equal(input._autoLayers, undefined);
  });

  it("does not duplicate when a reference line already exists", () => {
    const withRef = bar({
      _autoLayers: [{ type: "reference-line", on: "y", value: 0.5, label: "Target" }],
    });
    const [out] = attachOrgAverageReferenceLines([withRef]);
    assert.equal((out._autoLayers ?? []).filter((l) => l.type === "reference-line").length, 1);
    assert.equal(out._autoLayers![0].label, "Target");
  });

  it("skips trends, tiny breakdowns, and y-less charts", () => {
    const trend = bar({ type: "line" });
    const tiny = bar({ data: [{ ASM: "A", "PJP Adherence_rate": 0.9 }, { ASM: "B", "PJP Adherence_rate": 0.6 }] });
    const out = attachOrgAverageReferenceLines([trend, tiny]);
    assert.ok(out.every((c) => !(c._autoLayers ?? []).some((l) => l.type === "reference-line")));
  });
});
