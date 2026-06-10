import { describe, expect, it } from "vitest";
import { shouldAutoFit } from "./autoFitGuard";

describe("Wave S5 · shouldAutoFit", () => {
  const none = new Set<string>();

  it("allows a real height change on an un-resized tile", () => {
    expect(shouldAutoFit("t1", 7, 14, none)).toBe(true);
  });

  it("never overrides a user-resized tile", () => {
    expect(shouldAutoFit("t1", 7, 14, new Set(["t1"]))).toBe(false);
  });

  it("is idempotent when proposed rows equal the current height", () => {
    expect(shouldAutoFit("t1", 10, 10, none)).toBe(false);
  });

  it("rejects invalid proposed row counts", () => {
    expect(shouldAutoFit("t1", 0, 14, none)).toBe(false);
    expect(shouldAutoFit("t1", -3, 14, none)).toBe(false);
    expect(shouldAutoFit("t1", Number.NaN, 14, none)).toBe(false);
  });

  it("allows both growth and shrink", () => {
    expect(shouldAutoFit("t1", 20, 10, none)).toBe(true); // grow
    expect(shouldAutoFit("t1", 5, 10, none)).toBe(true); // shrink
  });
});
