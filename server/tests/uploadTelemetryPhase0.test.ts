import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentRssMb, logUploadTelemetry } from "../utils/uploadTelemetry.js";

describe("Phase 0 · uploadTelemetry", () => {
  it("currentRssMb returns a positive number", () => {
    const mb = currentRssMb();
    assert.equal(typeof mb, "number");
    assert.ok(mb > 0);
  });

  it("logUploadTelemetry does not throw on a valid record", () => {
    assert.doesNotThrow(() =>
      logUploadTelemetry({
        sessionId: "s",
        jobId: "j",
        source: "file",
        path: "chunking",
        rowCount: 1000,
        columnCount: 5,
        fileBytes: 12345,
        durationMs: 42,
        rssMb: 100,
        warnings: 0,
      }),
    );
  });
});
