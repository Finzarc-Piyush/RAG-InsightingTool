/**
 * Unit tests for the superadmin metrics per-turn aggregator.
 *
 * Guards the fix for "values wrong on all pages of superadmin": activity KPIs
 * are now derived from past_analyses (one doc per turn, with the turn's own
 * createdAt / userId / sessionId / per-turn charts / feedback) instead of from
 * session-lifetime counts attributed to the session's createdAt.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  summarizePastAnalysisRows,
  type PastAnalysisRow,
  type DailyRange,
  type DailyPoint,
} from "../lib/admin/metricsAggregator.js";
import { countTurnVotes } from "../lib/admin/feedbackVotes.js";

const ts = (y: number, m: number, d: number, h = 12): number =>
  Date.UTC(y, m - 1, d, h, 0, 0, 0);

const valueAt = (series: DailyPoint[], dateKey: string): number =>
  series.find((p) => p.dateKey === dateKey)?.value ?? 0;

const RANGE: DailyRange = { fromDateKey: "20260501", toDateKey: "20260531" };

const ROWS: PastAnalysisRow[] = [
  // userA, final day of window, 2 charts, answer-up + chart-up.
  {
    createdAt: ts(2026, 5, 31),
    userId: "UserA@x.com", // mixed-case → must be normalized
    sessionId: "S1",
    chartCount: 2,
    feedback: "up",
    feedbackDetails: [{ feedback: "up" }, { feedback: "up" }],
  },
  // userA again, same session, legacy root-only down vote.
  {
    createdAt: ts(2026, 5, 30),
    userId: "usera@x.com",
    sessionId: "S1",
    chartCount: 0,
    feedback: "down",
    feedbackDetails: [],
  },
  // userB, mid-window, 1 chart, no feedback.
  {
    createdAt: ts(2026, 5, 15),
    userId: "userB@x.com",
    sessionId: "S2",
    chartCount: 1,
    feedback: "none",
    feedbackDetails: [],
  },
  // userB, different session, CHART-LEVEL down vote only (root stays "none").
  // This is the exact bug case the old aggregator dropped.
  {
    createdAt: ts(2026, 5, 15),
    userId: "userB@x.com",
    sessionId: "S3",
    chartCount: 0,
    feedback: "none",
    feedbackDetails: [{ feedback: "down" }],
  },
  // userC, BEFORE the window (April) → must be excluded entirely.
  {
    createdAt: ts(2026, 4, 20),
    userId: "userC@x.com",
    sessionId: "S4",
    chartCount: 5,
    feedback: "up",
    feedbackDetails: [{ feedback: "up" }],
  },
];

describe("countTurnVotes", () => {
  it("counts every feedbackDetails entry (answer + per-chart)", () => {
    assert.deepEqual(
      countTurnVotes({
        feedbackDetails: [{ feedback: "up" }, { feedback: "down" }, { feedback: "up" }],
      }),
      { up: 2, down: 1 }
    );
  });

  it("falls back to the root field for legacy docs with no details", () => {
    assert.deepEqual(countTurnVotes({ feedback: "up" }), { up: 1, down: 0 });
    assert.deepEqual(countTurnVotes({ feedback: "down" }), { up: 0, down: 1 });
    assert.deepEqual(countTurnVotes({ feedback: "none" }), { up: 0, down: 0 });
  });

  it("counts a chart-only down vote that the old root-only path dropped", () => {
    assert.deepEqual(
      countTurnVotes({ feedback: "none", feedbackDetails: [{ feedback: "down" }] }),
      { up: 0, down: 1 }
    );
  });

  it("prefers details over root when both present", () => {
    assert.deepEqual(
      countTurnVotes({ feedback: "up", feedbackDetails: [{ feedback: "down" }] }),
      { up: 0, down: 1 }
    );
  });

  it("returns zero for an empty row", () => {
    assert.deepEqual(countTurnVotes({}), { up: 0, down: 0 });
  });
});

describe("summarizePastAnalysisRows", () => {
  const agg = summarizePastAnalysisRows(ROWS, RANGE);

  it("counts turns per day by each turn's own createdAt (excludes out-of-window)", () => {
    const total = agg.turnsByDay.reduce((s, p) => s + p.value, 0);
    assert.equal(total, 4); // April row excluded
    assert.equal(valueAt(agg.turnsByDay, "20260531"), 1);
    assert.equal(valueAt(agg.turnsByDay, "20260530"), 1);
    assert.equal(valueAt(agg.turnsByDay, "20260515"), 2);
    assert.equal(valueAt(agg.turnsByDay, "20260420"), 0);
  });

  it("sums per-turn charts attributed to the production day", () => {
    const total = agg.chartsByDay.reduce((s, p) => s + p.value, 0);
    assert.equal(total, 3);
    assert.equal(valueAt(agg.chartsByDay, "20260531"), 2);
    assert.equal(valueAt(agg.chartsByDay, "20260515"), 1);
  });

  it("computes distinct active users per day and across the window", () => {
    assert.equal(valueAt(agg.activeUsersByDay, "20260531"), 1);
    assert.equal(valueAt(agg.activeUsersByDay, "20260515"), 1);
    assert.equal(agg.windowActiveUsers, 2); // usera + userb (case-normalized)
  });

  it("DAU = users active on the final window day; WAU/WAU trailing windows", () => {
    assert.equal(agg.dauMauWau.dau, 1); // userA on 05-31
    assert.equal(agg.dauMauWau.wau, 1); // only userA in the last 7 days
    assert.equal(agg.dauMauWau.mau, 2); // userA + userB within 30 days
  });

  it("counts feedback from feedbackDetails incl. chart-level votes", () => {
    assert.equal(agg.totalUp, 2); // 2 ups on the 05-31 turn
    assert.equal(agg.totalDown, 2); // root-down (05-30) + chart-down (05-15)
    assert.equal(agg.totalNone, 1); // the no-vote turn
    assert.equal(valueAt(agg.thumbsUpByDay, "20260531"), 2);
    assert.equal(valueAt(agg.thumbsDownByDay, "20260530"), 1);
    assert.equal(valueAt(agg.thumbsDownByDay, "20260515"), 1);
  });

  it("builds top users with turns, charts and DISTINCT sessions", () => {
    const byEmail = new Map(agg.topUsers.map((u) => [u.userEmail, u]));
    const a = byEmail.get("usera@x.com");
    const b = byEmail.get("userb@x.com");
    assert.ok(a && b, "both users present, case-normalized");
    assert.deepEqual(
      { sessions: a!.sessions, messages: a!.messages, charts: a!.charts },
      { sessions: 1, messages: 2, charts: 2 }
    );
    assert.deepEqual(
      { sessions: b!.sessions, messages: b!.messages, charts: b!.charts },
      { sessions: 2, messages: 2, charts: 1 }
    );
  });

  it("returns empty aggregate for no rows", () => {
    const empty = summarizePastAnalysisRows([], RANGE);
    assert.equal(empty.turnsByDay.length, 0);
    assert.equal(empty.windowActiveUsers, 0);
    assert.deepEqual(empty.dauMauWau, { dau: 0, wau: 0, mau: 0 });
    assert.equal(empty.totalUp, 0);
    assert.equal(empty.totalDown, 0);
  });
});

describe("summarizePastAnalysisRows — cache-hit turns folded in", () => {
  // Mirrors the controller: cache-hit usage events become lightweight turn rows
  // (no charts, no feedback) merged with the real past_analyses rows.
  const freshRows: PastAnalysisRow[] = [
    {
      createdAt: ts(2026, 5, 31),
      userId: "userA@x.com",
      sessionId: "S1",
      chartCount: 2,
      feedback: "up",
      feedbackDetails: [{ feedback: "up" }],
    },
  ];
  const cacheHitRows: PastAnalysisRow[] = [
    // Same user, same day as a fresh turn → +1 question, NOT a new active user.
    { createdAt: ts(2026, 5, 31), userId: "userA@x.com", sessionId: "S1", chartCount: 0 },
    // A user whose only activity in the window is a cache hit.
    { createdAt: ts(2026, 5, 20), userId: "userD@x.com", sessionId: "S9", chartCount: 0 },
  ];
  const agg = summarizePastAnalysisRows([...freshRows, ...cacheHitRows], RANGE);

  it("counts cache hits as questions/turns", () => {
    assert.equal(agg.turnsByDay.reduce((s, p) => s + p.value, 0), 3);
    assert.equal(valueAt(agg.turnsByDay, "20260531"), 2); // fresh + cache hit
    assert.equal(valueAt(agg.turnsByDay, "20260520"), 1); // cache-hit-only user
  });

  it("does NOT double-count active users when a cache hit lands on an already-active day", () => {
    assert.equal(valueAt(agg.activeUsersByDay, "20260531"), 1); // userA once
    assert.equal(valueAt(agg.activeUsersByDay, "20260520"), 1); // userD
    assert.equal(agg.windowActiveUsers, 2); // userA + userD
  });

  it("cache hits add no charts and no feedback votes", () => {
    assert.equal(agg.chartsByDay.reduce((s, p) => s + p.value, 0), 2); // only the fresh turn
    assert.equal(agg.totalUp, 1);
    assert.equal(agg.totalDown, 0);
    assert.equal(agg.totalNone, 2); // the two vote-less cache-hit turns
  });

  it("attributes cache-hit questions to the right user in top-users", () => {
    const byEmail = new Map(agg.topUsers.map((u) => [u.userEmail, u]));
    assert.equal(byEmail.get("usera@x.com")!.messages, 2); // fresh + cache hit
    assert.equal(byEmail.get("usera@x.com")!.charts, 2);
    assert.equal(byEmail.get("userd@x.com")!.messages, 1);
    assert.equal(byEmail.get("userd@x.com")!.charts, 0);
  });
});
