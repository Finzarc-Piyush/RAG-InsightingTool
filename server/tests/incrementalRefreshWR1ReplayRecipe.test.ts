/**
 * Wave WR1 (incremental refresh) · replayRecipe extraction contract.
 *
 * WR1 extracted the deterministic replay core out of `replayAutomation` into
 * `replayRecipe(RecipeSource, {mode})` so the SAME engine drives automation
 * replay (append-messages) AND an in-place data refresh (overwrite). This file
 * pins the NEW, refresh-specific behaviour:
 *
 *   1. `computeRefreshTruncation` (the pure core of overwrite mode) splits the
 *      chat at the first user message (welcome prefix preserved), snapshots the
 *      WHOLE prior conversation + charts for rollback, and caps the snapshot
 *      list. This is what makes a refresh reversible and stops stale charts.
 *   2. A `buildRecipeFromChat` draft is STRUCTURALLY a `RecipeSource` (minus the
 *      synthetic `sourceId`) — so a refresh can build its recipe on the fly from
 *      the live chat with no persisted Automation.
 *
 * The end-to-end loop (Cosmos + ToolRegistry + live narrator) is exercised by
 * `replayLoopExecuteTurn.test.ts`; this file covers only the pure seams WR1
 * added, which is where the refresh-only logic lives.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRefreshTruncation,
  type RecipeSource,
} from "../lib/automations/replayLoop.service.js";
import { buildRecipeFromChat } from "../lib/automations/buildRecipeFromChat.js";

const msg = (role: "user" | "assistant", content: string, extra: object = {}) => ({
  role,
  content,
  timestamp: 1,
  ...extra,
});

describe("WR1 · computeRefreshTruncation (overwrite-mode core)", () => {
  it("preserves the welcome prefix and drops the analytical tail", () => {
    const prior = {
      messages: [
        msg("assistant", "Welcome! I've loaded your April data."),
        msg("user", "What were sales by brand?"),
        msg("assistant", "PARACHUTE led at ₹4.1Cr.", { charts: [{ title: "Sales by brand" }] }),
        msg("user", "And by channel?"),
        msg("assistant", "MT is 38% of value."),
      ],
      charts: [{ title: "Sales by brand" }, { title: "Sales by channel" }],
      chartReferences: [{ chartId: "c1" }],
      currentDataBlob: { version: 3 },
    } as never;

    const { welcomePrefix, messageVersions } = computeRefreshTruncation(
      prior,
      1_718_000_000_000,
      "as of May 2026"
    );

    // Welcome prefix = everything before the first user message.
    assert.equal(welcomePrefix.length, 1);
    assert.equal(welcomePrefix[0]?.role, "assistant");

    // The snapshot captured the FULL prior conversation + charts for rollback.
    assert.equal(messageVersions.length, 1);
    const snap = messageVersions[0]!;
    assert.equal(snap.messages.length, 5);
    assert.equal(snap.charts?.length, 2);
    assert.equal(snap.chartReferences?.length, 1);
    assert.equal(snap.dataVersion, 3);
    assert.equal(snap.label, "as of May 2026");
    assert.equal(snap.versionId, "msgs_3_1718000000000");
  });

  it("handles a chat with no user messages (welcome only) without throwing", () => {
    const prior = {
      messages: [msg("assistant", "Welcome!")],
    } as never;
    const { welcomePrefix, messageVersions } = computeRefreshTruncation(prior, 100);
    assert.equal(welcomePrefix.length, 1);
    assert.equal(messageVersions[0]?.messages.length, 1);
  });

  it("caps retained snapshots at 2 (newest first) to bound doc size", () => {
    const prior = {
      messages: [msg("user", "q"), msg("assistant", "a")],
      messageVersions: [
        { versionId: "old1", snapshotAt: 2, messages: [] },
        { versionId: "old2", snapshotAt: 1, messages: [] },
      ],
    } as never;
    const { messageVersions } = computeRefreshTruncation(prior, 999);
    assert.equal(messageVersions.length, 2);
    // Newest (this refresh) is first; the oldest pre-existing snapshot is dropped.
    assert.equal(messageVersions[0]?.versionId, "msgs_0_999");
    assert.equal(messageVersions[1]?.versionId, "old1");
  });

  it("empty messages → empty welcome prefix, snapshot still recorded", () => {
    const { welcomePrefix, messageVersions } = computeRefreshTruncation({} as never, 1);
    assert.equal(welcomePrefix.length, 0);
    assert.equal(messageVersions.length, 1);
    assert.equal(messageVersions[0]?.messages.length, 0);
  });
});

describe("WR1 · buildRecipeFromChat draft is a RecipeSource (minus sourceId)", () => {
  it("the captured draft carries every field replayRecipe consumes", () => {
    const chat = {
      id: "u@example.com_1",
      username: "u@example.com",
      fileName: "april.xlsx",
      sessionId: "session_1",
      dataSummary: {
        columns: [
          { name: "Brand", type: "string" },
          { name: "Sales", type: "number" },
        ],
        numericColumns: ["Sales"],
        dateColumns: [],
        rowCount: 10,
        columnCount: 2,
      },
      messages: [
        msg("assistant", "Welcome"),
        msg("user", "Sales by brand?"),
        msg("assistant", "PARACHUTE led.", {
          agentTrace: { steps: [{ id: "s1", tool: "execute_query_plan", args: { plan: { groupBy: ["Brand"] } } }] },
          charts: [{ title: "Sales by brand", type: "bar" }],
        }),
      ],
    } as never;

    const { draft } = buildRecipeFromChat(chat, { name: "April analysis" });

    // Structural assignment to RecipeSource must compile + hold at runtime.
    const source: RecipeSource = {
      recipe: draft.recipe,
      expectedSchema: draft.expectedSchema,
      sessionTransformations: draft.sessionTransformations,
      name: draft.name,
      sourceId: "refresh_session_1_1718000000000",
    };

    assert.equal(source.recipe.length, 1);
    assert.equal(source.recipe[0]?.question, "Sales by brand?");
    assert.ok(Array.isArray(source.expectedSchema.finalColumns));
    assert.equal(source.expectedSchema.finalColumns.length, 2);
    assert.equal(source.name, "April analysis");
  });
});
