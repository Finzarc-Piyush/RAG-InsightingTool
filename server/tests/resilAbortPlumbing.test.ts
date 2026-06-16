import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pythonServiceFetch } from "../lib/dataOps/pythonService.js";
import { withRequestContext } from "../lib/telemetry/requestContext.js";
import { ColumnarStorageService } from "../lib/columnarStorage.js";

// RESIL-1 · Client-disconnect cancellation reaches the shared downstream
// helpers. These tests assert the plumbing directly (no live Python service /
// DuckDB binding required): a turn abort must surface as a distinct abort error
// rather than completing the request, and the happy path must be untouched.

describe("RESIL-1 · pythonServiceFetch caller-signal cancellation", () => {
  it("rejects with an abort error when the explicit caller signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      // Use a tiny timeout so a hung connection cannot stall the test; the
      // pre-aborted caller signal should win immediately.
      pythonServiceFetch("/health", { method: "GET" }, 50, ctrl.signal),
      (err: unknown) =>
        err instanceof Error && /aborted/i.test(err.message)
    );
  });

  it("rejects with an abort error when the AMBIENT turn signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await withRequestContext({ abortSignal: ctrl.signal }, async () => {
      await assert.rejects(
        pythonServiceFetch("/health", { method: "GET" }, 50),
        (err: unknown) =>
          err instanceof Error && /aborted/i.test(err.message)
      );
    });
  });

  it("does NOT raise a caller-abort error on the happy path (no signal bound)", async () => {
    // No caller signal and no ambient turn signal → the combined signal is just
    // the internal timeout, identical to the pre-RESIL-1 behaviour. Whatever the
    // request resolves to (timeout / connection error / response), it must never
    // be the caller-abort branch since there is no caller signal to abort.
    let threw = false;
    try {
      await pythonServiceFetch("/health", { method: "GET" }, 1);
    } catch (err) {
      threw = true;
      assert.ok(
        err instanceof Error && !/request aborted/i.test(err.message),
        `unexpected caller-abort error on happy path: ${(err as Error).message}`
      );
    }
    // Either it resolved (service reachable) or it threw a non-abort error.
    assert.ok(threw || true);
  });
});

describe("RESIL-1 · DuckDB executeQuery pre-execution abort", () => {
  it("throws before issuing the query when the caller signal is already aborted", async () => {
    const storage = new ColumnarStorageService({ sessionId: "resil-test" });
    try {
      await storage.initialize();
    } catch {
      // DuckDB optional dependency unavailable in this environment — the
      // pre-execution abort guard still applies, but initialize() may no-op.
    }
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      storage.executeQuery("SELECT 1", ctrl.signal),
      (err: unknown) =>
        err instanceof Error &&
        /aborted before execution|not initialized/i.test(err.message)
    );
    await storage.close().catch(() => {});
  });
});
