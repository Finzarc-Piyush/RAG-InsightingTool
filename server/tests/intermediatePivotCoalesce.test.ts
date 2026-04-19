import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  filterProvisionalPivotDefaultsToPreviewKeys,
  intermediatePreviewSignature,
  isIntermediatePivotCoalesceEnabled,
  shouldEmitIntermediatePivotFlush,
} from "../services/chat/intermediatePivotPolicy.js";
import { sanitizeIntermediatePreviewRows } from "../lib/agentIntermediatePreviewSanitize.js";

describe("intermediatePivotPolicy", () => {
  const prev = process.env.AGENT_INTERMEDIATE_PIVOT_COALESCE;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_INTERMEDIATE_PIVOT_COALESCE;
    else process.env.AGENT_INTERMEDIATE_PIVOT_COALESCE = prev;
  });

  it("defaults coalesce to enabled when env unset", () => {
    delete process.env.AGENT_INTERMEDIATE_PIVOT_COALESCE;
    assert.equal(isIntermediatePivotCoalesceEnabled(), true);
  });

  it("treats false as disabled", () => {
    process.env.AGENT_INTERMEDIATE_PIVOT_COALESCE = "false";
    assert.equal(isIntermediatePivotCoalesceEnabled(), false);
  });

  it("skips a ≤1-row flush after a ≥2-row prior intermediate", () => {
    assert.equal(
      shouldEmitIntermediatePivotFlush({
        priorPendingTail: { preview: [{ a: 1 }, { a: 2 }] },
        incoming: { preview: [{ total: 1 }] },
      }),
      false
    );
  });

  it("emits the first intermediate when there is no prior", () => {
    assert.equal(
      shouldEmitIntermediatePivotFlush({
        priorPendingTail: undefined,
        incoming: { preview: [{ x: 1 }] },
      }),
      true
    );
  });

  it("emits when prior tail has no preview rows", () => {
    assert.equal(
      shouldEmitIntermediatePivotFlush({
        priorPendingTail: { preview: [] },
        incoming: { preview: [{ x: 1 }] },
      }),
      true
    );
  });

  it("emits a multi-row second flush after a single-row first", () => {
    assert.equal(
      shouldEmitIntermediatePivotFlush({
        priorPendingTail: { preview: [{ x: 1 }] },
        incoming: { preview: [{ a: 1 }, { a: 2 }] },
      }),
      true
    );
  });

  it("when coalesce is off, emits degenerate second flush", () => {
    process.env.AGENT_INTERMEDIATE_PIVOT_COALESCE = "false";
    assert.equal(
      shouldEmitIntermediatePivotFlush({
        priorPendingTail: { preview: [{ a: 1 }, { a: 2 }] },
        incoming: { preview: [{ total: 1 }] },
      }),
      true
    );
  });

  it("skips second flush when preview is identical to prior (signature)", () => {
    const preview = [{ Sales_sum: 1_000_000 }];
    const sig = intermediatePreviewSignature(preview);
    assert.equal(
      shouldEmitIntermediatePivotFlush({
        priorPendingTail: { preview, previewSignature: sig },
        incoming: { preview: [{ Sales_sum: 1_000_000 }] },
      }),
      false
    );
  });

  it("emits when same row count but different cell values", () => {
    assert.equal(
      shouldEmitIntermediatePivotFlush({
        priorPendingTail: { preview: [{ Sales_sum: 1 }] },
        incoming: { preview: [{ Sales_sum: 2 }] },
      }),
      true
    );
  });
});

describe("filterProvisionalPivotDefaultsToPreviewKeys", () => {
  it("drops row hints not present on preview keys", () => {
    const out = filterProvisionalPivotDefaultsToPreviewKeys(
      {
        rows: ["Month · Order Date", "Region"],
        values: ["Sales"],
      },
      [{ Sales_sum: 500 }]
    );
    assert.deepEqual(out?.rows, undefined);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("keeps row hints that appear as preview columns", () => {
    const out = filterProvisionalPivotDefaultsToPreviewKeys(
      {
        rows: ["Month · Order Date"],
        values: ["Sales"],
      },
      [{ "Month · Order Date": "2018-01", Sales_sum: 100 }]
    );
    assert.deepEqual(out?.rows, ["Month · Order Date"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });
});

describe("sanitizeIntermediatePreviewRows", () => {
  it("maps empty object dimension cells to null", () => {
    const out = sanitizeIntermediatePreviewRows([{ "Order Date": {}, Sales: 12 }]);
    assert.equal(out[0]!["Order Date"], null);
  });

  it("unwraps common single-key value wrappers", () => {
    const out = sanitizeIntermediatePreviewRows([{ d: { value: "2015-01-01" } }]);
    assert.equal(out[0]!.d, "2015-01-01");
  });

  it("leaves plain primitives unchanged", () => {
    const out = sanitizeIntermediatePreviewRows([{ d: "x", n: 3 }]);
    assert.deepEqual(out[0], { d: "x", n: 3 });
  });
});
