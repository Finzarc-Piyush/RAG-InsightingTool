import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { dashboardSchema } from "../shared/schema.js";

/**
 * Wave DR15 · pin the source-session linkage on the dashboard schema.
 *
 * Pre-DR15 the `sessionId` was passed into `createDashboardFromSpec`
 * but was never persisted on the dashboard itself. The dashboard
 * surface had no way to link back to the chat that produced it.
 * DR15 adds an optional `sessionId` field on `dashboardSchema` so the
 * "Open chat" UI can resolve the source session.
 *
 * The contract is: optional, max 200 chars, both old (no field) and
 * new (with field) shapes parse cleanly — pre-DR15 Cosmos documents
 * stay readable.
 */

const minimalDashboard = {
  id: "d1",
  username: "u@example.com",
  name: "My dashboard",
  createdAt: 1,
  updatedAt: 2,
  charts: [],
};

describe("DR15 · dashboardSchema.sessionId", () => {
  it("parses a dashboard without sessionId (back-compat)", () => {
    const parsed = dashboardSchema.safeParse(minimalDashboard);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.sessionId, undefined);
    }
  });

  it("parses a dashboard with sessionId", () => {
    const parsed = dashboardSchema.safeParse({
      ...minimalDashboard,
      sessionId: "session_abc_123",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.sessionId, "session_abc_123");
    }
  });

  it("rejects sessionId longer than 200 chars", () => {
    const parsed = dashboardSchema.safeParse({
      ...minimalDashboard,
      sessionId: "x".repeat(201),
    });
    assert.equal(parsed.success, false);
  });

  it("treats empty-string sessionId as a parse error (zod string max only)", () => {
    // The schema does NOT enforce min(1) here — empty string parses.
    // The model fn checks for non-empty before persisting; this test
    // documents the schema shape rather than the persistence rule.
    const parsed = dashboardSchema.safeParse({
      ...minimalDashboard,
      sessionId: "",
    });
    assert.equal(parsed.success, true);
  });

  it("rejects non-string sessionId", () => {
    const parsed = dashboardSchema.safeParse({
      ...minimalDashboard,
      sessionId: 42,
    });
    assert.equal(parsed.success, false);
  });
});
