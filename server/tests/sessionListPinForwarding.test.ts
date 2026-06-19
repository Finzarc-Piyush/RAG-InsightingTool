// Wave V-PIN1 · guards that the shared session-list projection forwards the
// sidebar pin fields. The bug: three inline maps in the list endpoints drifted
// and dropped `pinned`/`pinnedAt`, so the client never saw a pinned session and
// the pin reverted on every refetch. `toSessionListItem` is now the single
// projection used by all three endpoints — this test pins its contract.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { toSessionListItem } = await import(
  "../controllers/sessionController.js"
);

const base = {
  id: "id1",
  username: "u@x.com",
  fileName: "sales.xlsx",
  uploadedAt: 1,
  createdAt: 2,
  lastUpdatedAt: 3,
  collaborators: ["u@x.com"],
  sessionId: "s1",
};

describe("V-PIN1 · session-list projection forwards pin fields", () => {
  it("forwards pinned + pinnedAt when set", () => {
    const item = toSessionListItem(
      { ...base, pinned: true, pinnedAt: 999 },
      { messageCount: 4, chartCount: 2 }
    );
    assert.equal(item.pinned, true);
    assert.equal(item.pinnedAt, 999);
    assert.equal(item.messageCount, 4);
    assert.equal(item.chartCount, 2);
    assert.equal(item.sessionId, "s1");
  });

  it("leaves pinned/pinnedAt undefined for an unpinned session", () => {
    const item = toSessionListItem(base, { messageCount: 0, chartCount: 0 });
    assert.equal(item.pinned, undefined);
    assert.equal(item.pinnedAt, undefined);
  });

  it("defaults collaborators to the owner when none are stored", () => {
    const { collaborators: _omit, ...noCollab } = base;
    const item = toSessionListItem(noCollab, {
      messageCount: 1,
      chartCount: 0,
    });
    assert.deepEqual(item.collaborators, ["u@x.com"]);
  });
});
