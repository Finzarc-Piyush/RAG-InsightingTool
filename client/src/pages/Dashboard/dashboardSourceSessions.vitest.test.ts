import { describe, expect, it } from "vitest";
import { dashboardSourceSessions } from "./dashboardSourceSessions";

/**
 * DR15 · pin the source-session collection contract.
 *
 *  - empty dashboard → [] (no button surfaces)
 *  - dashboard.sessionId only → single entry, primary
 *  - dashboard.sessionId + pivot pulled from same session → de-duped
 *  - multi-source pivots → multiple entries, primary first
 *  - empty / whitespace-only ids ignored
 */

describe("dashboardSourceSessions", () => {
  it("returns [] for a dashboard with no source linkage", () => {
    expect(
      dashboardSourceSessions({
        sessionId: undefined,
        sheets: [],
      }),
    ).toEqual([]);
  });

  it("returns the dashboard's primary sessionId when set", () => {
    expect(
      dashboardSourceSessions({
        sessionId: "session_a",
        sheets: [],
      }),
    ).toEqual([{ sessionId: "session_a", isPrimary: true }]);
  });

  it("dedupes when a pivot tile re-references the primary session", () => {
    const out = dashboardSourceSessions({
      sessionId: "session_a",
      sheets: [
        {
          id: "s1",
          name: "S1",
          charts: [],
          pivots: [{ id: "p1", title: "Pivot", sourceSessionId: "session_a" } as any],
        } as any,
      ],
    });
    expect(out).toEqual([{ sessionId: "session_a", isPrimary: true }]);
  });

  it("collects distinct pivot sources alongside the primary", () => {
    const out = dashboardSourceSessions({
      sessionId: "session_a",
      sheets: [
        {
          id: "s1",
          name: "S1",
          charts: [],
          pivots: [
            { id: "p1", title: "P1", sourceSessionId: "session_b" } as any,
            { id: "p2", title: "P2", sourceSessionId: "session_c" } as any,
          ],
        } as any,
      ],
    });
    expect(out).toEqual([
      { sessionId: "session_a", isPrimary: true },
      { sessionId: "session_b", isPrimary: false },
      { sessionId: "session_c", isPrimary: false },
    ]);
  });

  it("works with pivots only when no dashboard.sessionId is set", () => {
    const out = dashboardSourceSessions({
      sessionId: undefined,
      sheets: [
        {
          id: "s1",
          name: "S1",
          charts: [],
          pivots: [{ id: "p1", title: "P1", sourceSessionId: "session_b" } as any],
        } as any,
      ],
    });
    expect(out).toEqual([{ sessionId: "session_b", isPrimary: false }]);
  });

  it("ignores blank / whitespace-only session ids", () => {
    expect(
      dashboardSourceSessions({
        sessionId: "   ",
        sheets: [
          {
            id: "s1",
            name: "S1",
            charts: [],
            pivots: [{ id: "p1", title: "P1", sourceSessionId: "" } as any],
          } as any,
        ],
      }),
    ).toEqual([]);
  });
});
