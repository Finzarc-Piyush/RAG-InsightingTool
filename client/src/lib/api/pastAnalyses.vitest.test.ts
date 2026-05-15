/**
 * AMR6 · The `fetchRecalledPivotRows` API client is the contract between
 * the client cache-hit path and the AMR3c recall endpoint. Pin:
 *   - URL shape: `/api/past-analyses/:sessionId/:turnId/pivot/:artifactId`.
 *   - Non-2xx → `null` (caller's UX layer surfaces error / retry).
 *   - 2xx but malformed body → `null` (defensive).
 *   - 2xx with the expected `{artifactId, rowCount, rows}` shape → returns
 *     the shape unchanged.
 *
 * Mocks `fetch` globally; doesn't hit the real endpoint.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Stub auth helpers — they import Azure MSAL which won't init in jsdom.
vi.mock("@/auth/msalToken", () => ({
  getAuthorizationHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));
vi.mock("@/utils/userStorage", () => ({
  getUserEmail: vi.fn(() => "user@example.com"),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
}));

describe("AMR6 · fetchRecalledPivotRows", () => {
  test("issues a GET to the correct URL shape and returns the body on 2xx", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            artifactId: "abc123",
            rowCount: 2,
            rows: [
              { Products: "MARICO", Value: 2200 },
              { Products: "PURITE", Value: 1700 },
            ],
          }),
        };
      })
    );
    const { fetchRecalledPivotRows } = await import("./pastAnalyses");
    const res = await fetchRecalledPivotRows({
      originalSessionId: "s_old",
      originalTurnId: "t_old",
      artifactId: "abc123",
    });
    expect(res).not.toBeNull();
    expect(res?.rowCount).toBe(2);
    expect(res?.rows).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(
      /\/api\/past-analyses\/s_old\/t_old\/pivot\/abc123$/
    );
    expect(calls[0]?.init?.method).toBe("GET");
  });

  test("URL-encodes session/turn/artifact path segments", async () => {
    const calls: { url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push({ url });
        return {
          ok: true,
          json: async () => ({ artifactId: "a", rowCount: 0, rows: [] }),
        };
      })
    );
    const { fetchRecalledPivotRows } = await import("./pastAnalyses");
    await fetchRecalledPivotRows({
      originalSessionId: "session with spaces/slashes",
      originalTurnId: "turn?q=1",
      artifactId: "a&b",
    });
    expect(calls[0]?.url).toMatch(/session%20with%20spaces%2Fslashes/);
    expect(calls[0]?.url).toMatch(/turn%3Fq%3D1/);
    expect(calls[0]?.url).toMatch(/a%26b$/);
  });

  test("returns null on a 404 (not found / wrong user)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, text: async () => "" }))
    );
    const { fetchRecalledPivotRows } = await import("./pastAnalyses");
    const res = await fetchRecalledPivotRows({
      originalSessionId: "s",
      originalTurnId: "t",
      artifactId: "x",
    });
    expect(res).toBeNull();
  });

  test("returns null on a 502 (blob fetch failed server-side)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, text: async () => "" }))
    );
    const { fetchRecalledPivotRows } = await import("./pastAnalyses");
    const res = await fetchRecalledPivotRows({
      originalSessionId: "s",
      originalTurnId: "t",
      artifactId: "x",
    });
    expect(res).toBeNull();
  });

  test("returns null when body lacks rows array (defensive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ artifactId: "x", rowCount: 0 /* no rows */ }),
      }))
    );
    const { fetchRecalledPivotRows } = await import("./pastAnalyses");
    const res = await fetchRecalledPivotRows({
      originalSessionId: "s",
      originalTurnId: "t",
      artifactId: "x",
    });
    expect(res).toBeNull();
  });

  test("returns null when fetch throws (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const { fetchRecalledPivotRows } = await import("./pastAnalyses");
    const res = await fetchRecalledPivotRows({
      originalSessionId: "s",
      originalTurnId: "t",
      artifactId: "x",
    });
    expect(res).toBeNull();
  });
});
