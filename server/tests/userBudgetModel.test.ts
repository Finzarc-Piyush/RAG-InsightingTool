import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dateKeyFromEpoch,
  userBudgetDocId,
} from "../models/userBudget.model.js";

/**
 * W6.1 · Pure-helper tests on the budget model. The Cosmos paths require a
 * live container and are covered by integration tests in W6.2.
 */

describe("userBudget · dateKeyFromEpoch", () => {
  it("formats UTC YYYYMMDD with zero-padding", () => {
    // 2024-03-05 14:30 UTC
    const ts = Date.UTC(2024, 2, 5, 14, 30);
    assert.strictEqual(dateKeyFromEpoch(ts), "20240305");
  });

  it("rolls at midnight UTC", () => {
    const lastSecondMar4 = Date.UTC(2024, 2, 4, 23, 59, 59, 999);
    const firstSecondMar5 = Date.UTC(2024, 2, 5, 0, 0, 0, 0);
    assert.strictEqual(dateKeyFromEpoch(lastSecondMar4), "20240304");
    assert.strictEqual(dateKeyFromEpoch(firstSecondMar5), "20240305");
  });

  it("handles Jan 1 / Dec 31 boundaries", () => {
    assert.strictEqual(dateKeyFromEpoch(Date.UTC(2026, 0, 1, 0, 0, 0)), "20260101");
    assert.strictEqual(
      dateKeyFromEpoch(Date.UTC(2025, 11, 31, 23, 59, 59)),
      "20251231"
    );
  });

  it("uses Date.now() when no argument supplied", () => {
    const result = dateKeyFromEpoch();
    assert.match(result, /^\d{8}$/);
  });
});

describe("userBudget · userBudgetDocId", () => {
  it("composes id as `${email-lowercased}__${dateKey}`", () => {
    assert.strictEqual(
      userBudgetDocId("User@Example.com", "20260424"),
      "user@example.com__20260424"
    );
  });

  it("two calls with the same inputs produce the identical id (idempotent)", () => {
    const a = userBudgetDocId("u@example.com", "20260424");
    const b = userBudgetDocId("u@example.com", "20260424");
    assert.strictEqual(a, b);
  });

  it("different dates produce different ids", () => {
    assert.notStrictEqual(
      userBudgetDocId("u@example.com", "20260424"),
      userBudgetDocId("u@example.com", "20260425")
    );
  });
});
