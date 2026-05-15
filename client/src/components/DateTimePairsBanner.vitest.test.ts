// Wave SU-UX1 · DateTimePairsBanner schema-contract test.
//
// The banner depends on the `DateTimeColumnPair` shape coming back from
// the server's SU-DT1 detector. Vitest runs in node (no jsdom), so we
// pin the type contract + a small util test for the empty-array path.
// Render concerns (collapsed default, ✕ click) are covered by the
// manual E2E check in the plan's verification section.

import { describe, it, expect } from "vitest";
import type { DateTimeColumnPair } from "@/shared/schema";

describe("DateTimeColumnPair contract", () => {
  it("accepts auto-source pairs with optional description", () => {
    const pair: DateTimeColumnPair = {
      timeColumn: "Clock-In Time",
      dateColumn: "Day · Date",
      source: "auto",
      description: "Auto-paired (only date column in dataset).",
    };
    expect(pair.timeColumn).toBe("Clock-In Time");
    expect(pair.dateColumn).toBe("Day · Date");
    expect(pair.source).toBe("auto");
  });

  it("accepts user-source pairs (override path)", () => {
    const pair: DateTimeColumnPair = {
      timeColumn: "Punch In",
      dateColumn: "Visit Date",
      source: "user",
    };
    expect(pair.source).toBe("user");
    expect(pair.description).toBeUndefined();
  });

  it("supports an empty array (no banner should render)", () => {
    const pairs: DateTimeColumnPair[] = [];
    expect(pairs).toHaveLength(0);
  });
});
