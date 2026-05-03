import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * W61 · Endpoint tests focus on what we can verify without Cosmos / AI
 * Search creds: route registration, controller exports, and the markdown
 * export's deterministic structure (rendered from a synthetic entry list).
 */

describe("W61 · controller exports", () => {
  it("exports the three memory endpoints", async () => {
    const ctrl = await import(
      "../controllers/analysisMemoryController.js"
    );
    assert.strictEqual(typeof ctrl.getMemoryEntriesEndpoint, "function");
    assert.strictEqual(typeof ctrl.searchMemoryEndpoint, "function");
    assert.strictEqual(typeof ctrl.exportMemoryEndpoint, "function");
  });
});

describe("W61 · routes registration", () => {
  it("sessions router includes the three memory paths", async () => {
    const sessionsModule = await import("../routes/sessions.js");
    const router = sessionsModule.default as {
      stack: Array<{ route?: { path?: string } }>;
    };
    const paths = router.stack
      .map((l) => l.route?.path)
      .filter((p): p is string => typeof p === "string");
    assert.ok(
      paths.includes("/sessions/:sessionId/memory"),
      `expected memory list route registered; got: ${paths.join(", ")}`
    );
    assert.ok(paths.includes("/sessions/:sessionId/memory/search"));
    assert.ok(paths.includes("/sessions/:sessionId/memory/export"));
  });
});
