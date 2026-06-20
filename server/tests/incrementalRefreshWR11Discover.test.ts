/**
 * Wave WR11 (incremental refresh) · fresh-planner discovery pass.
 *
 * The agent turns are full LLM runs (manual E2E). This pins the pure question
 * selector: it picks fresh suggested questions the chat hasn't already answered,
 * dedups, caps, and falls back to a generic prompt when nothing fresh remains —
 * so discovery never re-asks what was already answered, and never no-ops.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectDiscoveryQuestions } from "../lib/refresh/discoverNewInsights.js";
import type { ChatDocument } from "../models/chat.model.js";

const chatWith = (over: Partial<ChatDocument>): ChatDocument =>
  ({ messages: [], ...over }) as ChatDocument;

describe("WR11 · selectDiscoveryQuestions", () => {
  it("picks fresh follow-ups the chat hasn't answered, capped", () => {
    const chat = chatWith({
      messages: [{ role: "user", content: "What were sales by brand?", timestamp: 1 }] as never,
      sessionAnalysisContext: {
        suggestedFollowUps: [
          "What were sales by brand?", // already answered → excluded
          "What's the month-over-month trend?",
          "Which channel grew fastest?",
          "Which region declined?",
        ],
      } as never,
    });
    const qs = selectDiscoveryQuestions(chat, 2);
    assert.equal(qs.length, 2);
    assert.ok(!qs.includes("What were sales by brand?"));
    assert.equal(qs[0], "What's the month-over-month trend?");
  });

  it("merges profile questions and dedups (case/space-insensitive)", () => {
    const chat = chatWith({
      sessionAnalysisContext: { suggestedFollowUps: ["Trend over time?"] } as never,
      datasetProfile: {
        suggestedQuestions: ["trend  over   time?", "New segments?"],
      } as never,
    });
    const qs = selectDiscoveryQuestions(chat, 5);
    assert.deepEqual(qs, ["Trend over time?", "New segments?"]);
  });

  it("falls back to a generic discovery prompt when nothing fresh remains", () => {
    const chat = chatWith({
      messages: [{ role: "user", content: "Only question", timestamp: 1 }] as never,
      sessionAnalysisContext: { suggestedFollowUps: ["only question"] } as never,
    });
    const qs = selectDiscoveryQuestions(chat, 3);
    assert.equal(qs.length, 1);
    assert.match(qs[0]!, /new trends or changes/i);
  });
});
