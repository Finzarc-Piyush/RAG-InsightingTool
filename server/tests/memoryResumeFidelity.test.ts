import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTurnEndMemoryEntries } from "../lib/agents/runtime/memoryEntryBuilders.js";
import {
  buildAnalysisCreatedEntry,
  buildEnrichmentCompleteEntry,
  buildDashboardPromotedEntry,
  buildComputedColumnEntry,
} from "../lib/agents/runtime/memoryLifecycleBuilders.js";
import type { Message, InvestigationSummary } from "../shared/schema.js";

/**
 * W63 · Resume-fidelity end-to-end test (deterministic / no Cosmos / no Azure).
 *
 * Simulates the full flow of a multi-turn analysis with intermixed lifecycle
 * events, then asserts:
 *   1. Every event becomes one entry with a stable, idempotent id.
 *   2. The set of entry ids is unique (no two events collide).
 *   3. Replaying the simulation produces identical entries — safe for
 *      backfills and replays.
 *   4. A follow-up turn's question still maps cleanly to a memory entry that
 *      references the prior turn (turnId scoping).
 *
 * The Azure Search retrieval side is exercised separately
 * (memoryRecallFormatter.test.ts + integration smoke); this test pins the
 * pure-data layer that the UI page (W62) and the agent recall block (W60)
 * both consume.
 */

function turnAssistant(overrides: Partial<Message> = {}): Message {
  return {
    role: "assistant",
    content: "East tech grew 23% Mar→Apr.",
    timestamp: 1_773_000_000_000,
    charts: [],
    insights: [],
    answerEnvelope: {
      tldr: "East tech grew 23% Mar→Apr.",
      findings: [
        { headline: "East region tech sales up 23%", evidence: "execute_query_plan" },
      ],
      nextSteps: ["Investigate Q2 carryover."],
    },
    ...overrides,
  };
}

function simulateSession(): Array<{ id: string }> {
  const sessionId = "sess_resume_test";
  const username = "u@example.com";
  const allEntries: Array<{ id: string }> = [];

  // Lifecycle 1 — upload.
  allEntries.push(
    buildAnalysisCreatedEntry({
      sessionId,
      username,
      fileName: "Q1.csv",
      fileSize: 2 * 1024 * 1024,
      createdAt: 1_773_000_000_000,
    })
  );

  // Lifecycle 2 — enrichment.
  allEntries.push(
    buildEnrichmentCompleteEntry({
      sessionId,
      username,
      rowCount: 12_500,
      columnCount: 18,
      suggestedQuestions: ["What drove Q1?", "Which region grew?"],
      createdAt: 1_773_000_000_001,
    })
  );

  // Turn 1 — question + investigation + conclusion.
  allEntries.push(
    ...buildTurnEndMemoryEntries({
      sessionId,
      username,
      turnId: "turn_001",
      dataVersion: 1,
      createdAt: 1_773_000_001_000,
      question: "Why did Q1 sales rise?",
      assistant: turnAssistant(),
      investigationSummary: {
        hypotheses: [
          { text: "East tech drove growth", status: "confirmed", evidenceCount: 3 },
        ],
        findings: [{ label: "East region grew 23%", significance: "anomalous" }],
      } satisfies InvestigationSummary,
    })
  );

  // Lifecycle 3 — computed column added during turn 2.
  allEntries.push(
    buildComputedColumnEntry({
      sessionId,
      username,
      columns: [
        {
          name: "yoy_growth",
          def: {
            type: "numeric_binary",
            op: "subtract",
            leftColumn: "Sales_2026",
            rightColumn: "Sales_2025",
          },
        },
      ],
      persistedToBlob: false,
      createdAt: 1_773_000_002_000,
      turnId: "turn_002",
    })
  );

  // Turn 2 — follow-up referencing turn 1's investigation.
  allEntries.push(
    ...buildTurnEndMemoryEntries({
      sessionId,
      username,
      turnId: "turn_002",
      dataVersion: 1,
      createdAt: 1_773_000_002_500,
      question: "Re-run that analysis with a 30-day window",
      assistant: turnAssistant({
        answerEnvelope: {
          tldr: "30-day window confirms East tech growth at 21% (vs 23% Q1).",
          findings: [
            {
              headline: "East tech growth holds in 30-day window",
              evidence: "execute_query_plan",
            },
          ],
        },
      }),
      investigationSummary: {
        hypotheses: [
          {
            text: "Growth pattern is durable beyond Q1",
            status: "confirmed",
            evidenceCount: 2,
          },
        ],
      } satisfies InvestigationSummary,
    })
  );

  // Lifecycle 4 — dashboard promoted.
  allEntries.push(
    buildDashboardPromotedEntry({
      sessionId,
      username,
      dashboardId: "Q1_Sales_Review_1773",
      dashboardName: "Q1 Sales Review",
      sheetCount: 3,
      chartCount: 7,
      createdAt: 1_773_000_003_000,
      turnId: "turn_002",
    })
  );

  return allEntries;
}

describe("W63 · resume-fidelity end-to-end", () => {
  it("simulated 2-turn session produces a coherent journal", () => {
    const entries = simulateSession();
    assert.ok(
      entries.length >= 8,
      `expected ≥8 entries from 2 turns + 4 lifecycle events; got ${entries.length}`
    );
  });

  it("every entry id is unique — no collisions across types/turns/sequences", () => {
    const entries = simulateSession();
    const ids = entries.map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it("replay produces identical entries — safe for backfill + retry", () => {
    const a = simulateSession().map((e) => e.id);
    const b = simulateSession().map((e) => e.id);
    assert.deepStrictEqual(a, b);
  });

  it("turn 2's entries are bucket-tagged by turn_002 so the recall block can scope them", () => {
    const entries = simulateSession();
    const turn2 = entries.filter((e) => e.id.includes("__turn_002__"));
    const turn1 = entries.filter((e) => e.id.includes("__turn_001__"));
    assert.ok(turn1.length >= 2, "turn 1 should have its own entries");
    assert.ok(turn2.length >= 2, "turn 2 should have its own entries");
  });
});
