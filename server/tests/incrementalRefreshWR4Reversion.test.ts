/**
 * Wave WR4 (incremental refresh) · dashboard re-versioning core.
 *
 * The Cosmos writes (`createDashboardFromSpec` / supersede stamps / pointer
 * repoint) are covered by the dashboard-model tests + the manual end-to-end.
 * This file pins the pure seam WR4 added: pulling the regenerated dashboard
 * spec off the replayed conversation. Getting THIS wrong = re-versioning the
 * wrong (or no) dashboard.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractRegeneratedDashboardSpec } from "../lib/refresh/reversionDashboard.js";
import type { Message } from "../shared/schema.js";

const validSpec = {
  name: "Q2 Haircare Leadership",
  template: "executive",
  sheets: [{ id: "sheet_0", name: "Executive Summary" }],
};

describe("WR4 · extractRegeneratedDashboardSpec", () => {
  it("returns the LAST assistant dashboardDraft that validates", () => {
    const messages = [
      { role: "user", content: "q1", timestamp: 1 },
      {
        role: "assistant",
        content: "a1",
        timestamp: 2,
        dashboardDraft: { name: "Old draft", sheets: [] },
      },
      { role: "user", content: "q2", timestamp: 3 },
      { role: "assistant", content: "a2", timestamp: 4, dashboardDraft: validSpec },
    ] as unknown as Message[];

    const spec = extractRegeneratedDashboardSpec(messages);
    assert.ok(spec, "a spec is found");
    assert.equal(spec?.name, "Q2 Haircare Leadership");
    assert.equal(spec?.sheets[0]?.name, "Executive Summary");
    assert.equal(spec?.template, "executive");
  });

  it("returns undefined when no assistant message carries a dashboard", () => {
    const messages = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
    ] as unknown as Message[];
    assert.equal(extractRegeneratedDashboardSpec(messages), undefined);
  });

  it("skips a malformed draft and falls back to an earlier valid one", () => {
    const messages = [
      { role: "assistant", content: "a1", timestamp: 1, dashboardDraft: validSpec },
      // malformed: `sheets` must be an array
      { role: "assistant", content: "a2", timestamp: 2, dashboardDraft: { name: "Bad", sheets: 5 } },
    ] as unknown as Message[];
    const spec = extractRegeneratedDashboardSpec(messages);
    assert.equal(spec?.name, "Q2 Haircare Leadership");
  });

  it("ignores user messages even if they somehow carry a draft", () => {
    const messages = [
      { role: "user", content: "q", timestamp: 1, dashboardDraft: validSpec },
    ] as unknown as Message[];
    assert.equal(extractRegeneratedDashboardSpec(messages), undefined);
  });
});
