import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideEnrichmentGate } from "../services/chat/enrichmentGate.js";

/**
 * The chat answer path may only run once enrichment is complete. Both the
 * streaming and non-streaming guards share `decideEnrichmentGate`. This locks
 * the 3-way decision so a future edit can't silently let a question through
 * (or strand it) while enrichment is still in flight.
 */
describe("decideEnrichmentGate", () => {
  it("queues while enrichment is pending or in_progress", () => {
    assert.equal(decideEnrichmentGate("pending"), "queued");
    assert.equal(decideEnrichmentGate("in_progress"), "queued");
  });

  it("fails when enrichment failed", () => {
    assert.equal(decideEnrichmentGate("failed"), "failed");
  });

  it("proceeds when complete", () => {
    assert.equal(decideEnrichmentGate("complete"), "proceed");
  });

  it("proceeds for unknown/legacy/missing status (never strands a turn)", () => {
    assert.equal(decideEnrichmentGate(undefined), "proceed");
    assert.equal(decideEnrichmentGate(null), "proceed");
    assert.equal(decideEnrichmentGate(""), "proceed");
    assert.equal(decideEnrichmentGate("something-else"), "proceed");
  });
});
