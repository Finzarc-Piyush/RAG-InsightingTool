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
