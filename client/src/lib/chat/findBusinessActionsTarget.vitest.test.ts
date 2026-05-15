import { describe, expect, test } from "vitest";
import {
  findBusinessActionsTargetIndex,
  type BusinessActionsTargetCandidate,
} from "./findBusinessActionsTarget";

/**
 * Wave C1 · Pins the SSE business_actions → message matching logic.
 *
 * Pre-C1 the SSE handler picked "the most recent assistant message" by
 * recency. That was fine while the user only had one turn in flight
 * but broke when the user regenerated mid-stream OR fired a new turn
 * within the BAI agent's 12-second timeout window. C1 prefers EXACT
 * timestamp match (within ±2000ms) and falls back to recency only when
 * no match exists.
 */

const mkAssistant = (ts: number): BusinessActionsTargetCandidate => ({
  role: "assistant",
  isIntermediate: false,
  timestamp: ts,
});
const mkUser = (ts: number): BusinessActionsTargetCandidate => ({
  role: "user",
  isIntermediate: false,
  timestamp: ts,
});
const mkIntermediate = (ts: number): BusinessActionsTargetCandidate => ({
  role: "assistant",
  isIntermediate: true,
  timestamp: ts,
});

describe("Wave C1 · findBusinessActionsTargetIndex — exact-timestamp match", () => {
  test("exact match wins over recency (messages >2s apart)", () => {
    const messages = [
      mkUser(1_000),
      mkAssistant(2_000), // target
      mkUser(10_000),
      mkAssistant(12_000), // more recent and outside tolerance from the target
    ];
    const idx = findBusinessActionsTargetIndex(messages, 2_000);
    expect(idx).toBe(1);
  });

  test("match within ±2000ms tolerance still wins (server drift)", () => {
    const messages = [
      mkUser(1_000),
      mkAssistant(2_000), // server says 2_500, drift 500ms
      mkUser(10_000),
      mkAssistant(12_000), // newer but >2s away from 2_500
    ];
    const idx = findBusinessActionsTargetIndex(messages, 2_500);
    expect(idx).toBe(1);
  });

  test("match at exactly 2000ms drift wins under newest-first; ambiguous tie goes to the newer", () => {
    const messages = [mkAssistant(1_000), mkAssistant(5_000)];
    const idx = findBusinessActionsTargetIndex(messages, 3_000); // exactly 2000ms from both
    // Newest-first iteration: 5_000 first; |5_000-3_000|=2_000 → matches → wins.
    expect(idx).toBe(1);
  });

  test("drift > 2000ms from EVERY message falls back to most-recent (Pass 2)", () => {
    const messages = [mkAssistant(1_000), mkAssistant(5_000)];
    const idx = findBusinessActionsTargetIndex(messages, 100_000); // 100s — far from everything
    // Pass 1 finds nothing; Pass 2 picks newest assistant.
    expect(idx).toBe(1);
  });

  test("when multiple messages tie within tolerance, the newest wins", () => {
    const messages = [
      mkAssistant(2000), // within tolerance
      mkAssistant(2400), // also within tolerance (newer)
    ];
    const idx = findBusinessActionsTargetIndex(messages, 2200);
    expect(idx).toBe(1); // newest matching
  });
});

describe("Wave C1 · findBusinessActionsTargetIndex — fallback semantics", () => {
  test("null serverTs falls straight to Pass 2 (most-recent assistant)", () => {
    const messages = [mkUser(1000), mkAssistant(2000), mkUser(3000), mkAssistant(4000)];
    const idx = findBusinessActionsTargetIndex(messages, null);
    expect(idx).toBe(3);
  });

  test("non-finite serverTs falls through to Pass 2", () => {
    const messages = [mkAssistant(1000), mkAssistant(2000)];
    const idx = findBusinessActionsTargetIndex(messages, NaN);
    expect(idx).toBe(1);
  });

  test("Pass 2 skips intermediate assistant messages", () => {
    const messages = [
      mkAssistant(1000), // valid target
      mkIntermediate(2000), // intermediate (planning row) — skip
      mkIntermediate(3000),
    ];
    const idx = findBusinessActionsTargetIndex(messages, null);
    expect(idx).toBe(0); // the non-intermediate assistant
  });

  test("returns -1 when there is no eligible assistant message", () => {
    const messages = [mkUser(1000), mkUser(2000), mkIntermediate(3000)];
    const idx = findBusinessActionsTargetIndex(messages, 2000);
    expect(idx).toBe(-1);
  });

  test("empty array returns -1", () => {
    expect(findBusinessActionsTargetIndex([], null)).toBe(-1);
    expect(findBusinessActionsTargetIndex([], 1000)).toBe(-1);
  });
});

describe("Wave C1 · regenerate-mid-stream scenario", () => {
  test("after regenerate, exact match attaches BAI to the OLD message, not the new one (timestamps >2s apart)", () => {
    // Scenario: user submits turn A at T=1_000, gets response, server fires
    // BAI promise. ~10s later (within the 12s BAI timeout window) user
    // clicks regenerate at T=11_000 which creates a NEW assistant
    // message. Server's BAI for the ORIGINAL turn finally resolves at
    // T=11_500 with messageTimestamp=1_000.
    //
    // Pre-C1: items would attach to the regenerate response (newest).
    // Post-C1: items attach to the original (timestamp match).
    const messages = [
      mkUser(900),
      mkAssistant(1_000), // original turn's response — target
      mkUser(10_900),
      mkAssistant(11_000), // regenerated response (newer but outside ±2s of original)
    ];
    const idx = findBusinessActionsTargetIndex(messages, 1_000);
    expect(idx).toBe(1);
  });

  test("rapid double-turn: each BAI attaches to its own turn (>2s apart)", () => {
    const messages = [
      mkUser(900),
      mkAssistant(1_000), // turn A response
      mkUser(9_900),
      mkAssistant(10_000), // turn B response
    ];
    expect(findBusinessActionsTargetIndex(messages, 1_000)).toBe(1); // A's BAI → A
    expect(findBusinessActionsTargetIndex(messages, 10_000)).toBe(3); // B's BAI → B
  });
});
