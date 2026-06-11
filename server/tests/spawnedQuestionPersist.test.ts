/**
 * Wave W1 (C6) · the {id, question} subset persisted onto an assistant message.
 *
 * Guards the persistence contract the C6 bug exposed: answerQuestion now forwards
 * `spawnedQuestions`, and chatStream persists this projection. The projection must
 * drop malformed entries, preserve order, and respect the message-schema cap so a
 * persist never fails zod validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toPersistedSpawnedQuestions,
  PERSISTED_SPAWNED_QUESTIONS_MAX,
} from "../lib/agents/runtime/spawnedQuestionPersist.js";

describe("W1 · toPersistedSpawnedQuestions", () => {
  it("projects rich spawned questions to the {id, question} subset, preserving order", () => {
    const out = toPersistedSpawnedQuestions([
      { id: "a", question: "Which TSOE names have the highest compliance visits?", spawnReason: "anomaly", priority: "high", suggestedColumns: ["TSOE"] },
      { id: "b", question: "What is Android/iOS usage by ASM?", priority: "medium" },
    ]);
    assert.deepEqual(out, [
      { id: "a", question: "Which TSOE names have the highest compliance visits?" },
      { id: "b", question: "What is Android/iOS usage by ASM?" },
    ]);
  });

  it("drops entries missing a string id or question", () => {
    const out = toPersistedSpawnedQuestions([
      { id: "ok", question: "Real question?" },
      { id: "", question: "empty id" },
      { question: "no id" },
      { id: "no-question" },
      { id: "blank-q", question: "" },
      null,
      undefined,
      { id: 7 as unknown as string, question: "numeric id" },
    ]);
    assert.deepEqual(out, [{ id: "ok", question: "Real question?" }]);
  });

  it("returns [] for empty / non-array input", () => {
    assert.deepEqual(toPersistedSpawnedQuestions([]), []);
    assert.deepEqual(toPersistedSpawnedQuestions(null), []);
    assert.deepEqual(toPersistedSpawnedQuestions(undefined), []);
  });

  it("caps at the message-schema limit so a persist never exceeds .max(16)", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `id${i}`, question: `q${i}?` }));
    const out = toPersistedSpawnedQuestions(many);
    assert.equal(out.length, PERSISTED_SPAWNED_QUESTIONS_MAX);
    assert.equal(out[0].id, "id0");
    assert.equal(out[PERSISTED_SPAWNED_QUESTIONS_MAX - 1].id, `id${PERSISTED_SPAWNED_QUESTIONS_MAX - 1}`);
  });
});
