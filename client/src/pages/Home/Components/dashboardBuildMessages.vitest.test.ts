import { describe, expect, test } from "vitest";
import { DASHBOARD_BUILD_MESSAGES } from "./dashboardBuildMessages";

describe("DASHBOARD_BUILD_MESSAGES", () => {
  test("ships at least 100 lines", () => {
    expect(DASHBOARD_BUILD_MESSAGES.length).toBeGreaterThanOrEqual(100);
  });

  test("every line is non-empty and trimmed", () => {
    for (const line of DASHBOARD_BUILD_MESSAGES) {
      expect(line.length).toBeGreaterThan(0);
      expect(line).toBe(line.trim());
    }
  });

  test("no duplicates (case-insensitive, ignoring trailing punctuation)", () => {
    const seen = new Set<string>();
    for (const line of DASHBOARD_BUILD_MESSAGES) {
      const key = line.toLowerCase().replace(/[\s.…]+$/g, "");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("lines stay short enough to fit one row (<= 64 chars)", () => {
    for (const line of DASHBOARD_BUILD_MESSAGES) {
      expect(line.length).toBeLessThanOrEqual(64);
    }
  });

  test("no finality / completion phrasing (rotation is order-agnostic)", () => {
    // Lines render in random order across the build window, so any line
    // implying we are nearly done would read as a lie mid-build.
    const banned = /\b(almost|finishing|finished|saving now|all done|nearly there|final touch|last touch|wrapping up)\b/i;
    for (const line of DASHBOARD_BUILD_MESSAGES) {
      expect(banned.test(line)).toBe(false);
    }
  });
});
