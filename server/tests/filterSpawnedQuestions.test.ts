/**
 * Wave MW1 · the "Investigating further" chip gate.
 *
 * Hard rule: a RANDOM-SAMPLE question is NEVER surfaced. Also drops duplicates
 * (vs prior + within batch) and per-identifier groupings ("… by <rep code>").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterSpawnedQuestions } from "../lib/agents/runtime/filterSpawnedQuestions.js";

const q = (question: string, extra: Record<string, unknown> = {}) => ({ question, ...extra });

describe("MW1 · filterSpawnedQuestions", () => {
  it("drops random-sample questions (the hard rule)", () => {
    const out = filterSpawnedQuestions([
      q("Which 5 random TSOE names and their compliance visits can be sampled for the dashboard?"),
      q("What is PJP Adherence by Cluster Name?"),
      q("Show a representative sample of reps"),
      q("Pick reps randomly to inspect"),
    ]);
    assert.deepEqual(
      out.map((x) => x.question),
      ["What is PJP Adherence by Cluster Name?"]
    );
  });

  it("dedupes within the batch and against prior questions", () => {
    const out = filterSpawnedQuestions(
      [
        q("What is PJP Adherence by Cluster Name?"),
        q("What is PJP Adherence by Cluster Name?"), // dup within batch
        q("What is Compliance Visit by ASM?"),
        q("What is PJP adherence by cluster name"), // near-dup (case/punct)
      ],
      { priorQuestions: ["What is Compliance Visit by ASM?"] } // already shown
    );
    assert.deepEqual(
      out.map((x) => x.question),
      ["What is PJP Adherence by Cluster Name?"]
    );
  });

  it("collapses paraphrased duplicates that differ only in framing/ranking words", () => {
    // The two pairs a user saw repeated under "Investigating further": same
    // analytical intent, different wording. Each pair must reduce to ONE chip.
    const out = filterSpawnedQuestions([
      q("Which 10 TSOEs have the highest Compliance Visit count?"),
      q("What are the top 10 TSOE names by Compliance Visit?"), // paraphrase of #1
      q("What is Android./iOS usage by ASM?"),
      q("How does Android./iOS usage vary by ASM?"), // paraphrase of #3
    ]);
    assert.deepEqual(out.map((x) => x.question), [
      "Which 10 TSOEs have the highest Compliance Visit count?",
      "What is Android./iOS usage by ASM?",
    ]);
  });

  it("collapses a paraphrase against a prior-question (cross-step dedup)", () => {
    const out = filterSpawnedQuestions(
      [q("What are the top 10 TSOE names by Compliance Visit?")],
      { priorQuestions: ["Which 10 TSOEs have the highest Compliance Visit count?"] }
    );
    assert.deepEqual(out.map((x) => x.question), []);
  });

  it("does NOT collapse questions that differ by aggregation (average vs total)", () => {
    // Aggregation qualifiers carry meaning — these are genuinely different.
    const out = filterSpawnedQuestions([
      q("What is average PJP Adherence by ASM?"),
      q("What is total PJP Adherence by ASM?"),
    ]);
    assert.equal(out.length, 2);
  });

  it("drops questions grouping by an identifier-shaped column, keeps real dimensions", () => {
    const out = filterSpawnedQuestions(
      [
        q("Which 10 TSO_TSE Code have the highest Compliance Visit totals?"),
        q("What is Compliance Visit by ASM?"),
        q("What is PJP Adherence by Cluster Name?"),
      ],
      { excludedColumns: ["TSO_TSE Code", "ASM", "Cluster Name", "Compliance Visit"] }
    );
    // TSO_TSE Code is identifier-shaped (/\bcode\b/) → dropped; ASM/Cluster kept.
    assert.deepEqual(
      out.map((x) => x.question),
      ["What is Compliance Visit by ASM?", "What is PJP Adherence by Cluster Name?"]
    );
  });

  it("does NOT exclude legitimate low-cardinality dimensions passed in excludedColumns", () => {
    // Only identifier-shaped names act as excluders — ASM/Cluster Name are not.
    const out = filterSpawnedQuestions([q("What is PJP Adherence by ASM?")], {
      excludedColumns: ["ASM", "Cluster Name"],
    });
    assert.equal(out.length, 1);
  });

  it("preserves order and the original object shape (id, priority, etc.)", () => {
    const out = filterSpawnedQuestions([
      q("What is PJP Adherence by Cluster Name?", { id: "a", priority: "high" }),
      q("Sample 5 random reps"),
      q("What is Compliance Visit by ASM?", { id: "b", priority: "low" }),
    ]);
    assert.deepEqual(out.map((x) => x.id), ["a", "b"]);
    assert.equal(out[0].priority, "high");
  });

  it("is a no-op safe on empty / blank input", () => {
    assert.deepEqual(filterSpawnedQuestions([]), []);
    assert.deepEqual(filterSpawnedQuestions([q("   ")]), []);
  });
});
