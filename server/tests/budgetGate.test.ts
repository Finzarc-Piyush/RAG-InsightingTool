import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { secondsUntilUtcMidnight } from "../middleware/budgetGate.js";

/**
 * W6.2 · Pure-logic guards on the budget middleware. The Cosmos integration
 * (atomic increment) is covered by integration tests against an emulator.
 */

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("secondsUntilUtcMidnight", () => {
  it("returns ~24h - 0 when called at midnight UTC exactly", () => {
    const ts = Date.UTC(2026, 3, 24, 0, 0, 0, 0);
    const s = secondsUntilUtcMidnight(ts);
    assert.strictEqual(s, 86400);
  });

  it("returns small positive seconds late in the day UTC", () => {
    // 23:59:30 UTC → 30 seconds left (with ceil from any millisecond drift)
    const ts = Date.UTC(2026, 3, 24, 23, 59, 30, 0);
    const s = secondsUntilUtcMidnight(ts);
    assert.ok(s > 0 && s <= 30, `expected <=30s left, got ${s}`);
  });

  it("rolls correctly across a day boundary", () => {
    const lastMs = Date.UTC(2026, 3, 24, 23, 59, 59, 999);
    const firstMs = Date.UTC(2026, 3, 25, 0, 0, 0, 0);
    const a = secondsUntilUtcMidnight(lastMs);
    const b = secondsUntilUtcMidnight(firstMs);
    assert.strictEqual(a, 1);     // ceiling of 1ms = 1s
    assert.strictEqual(b, 86400); // exactly midnight → full next day
  });

  it("uses Date.now() default when no arg supplied", () => {
    const s = secondsUntilUtcMidnight();
    assert.ok(s > 0 && s <= 86400);
  });
});
