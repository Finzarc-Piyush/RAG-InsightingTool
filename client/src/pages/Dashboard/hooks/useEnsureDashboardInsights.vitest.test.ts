/**
 * Wave W-INS1 · the dashboard insight self-heal (`ensure-insights`) is the
 * primary "generate insights by default" path. It uses raw `fetch`, so it must
 * attach the Bearer token or it 401s silently (the catch only logs) and tiles
 * stay "No insight yet" — which is exactly the reported symptom. Pin that the
 * token reaches the wire, and that the once-per-dashboard gate still holds.
 * See docs/conventions/authed-raw-fetch.md.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/auth/msalToken", () => ({
  getAuthorizationHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
}));

import { useEnsureDashboardInsights } from "./useEnsureDashboardInsights";

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("W-INS1 · useEnsureDashboardInsights auth", () => {
  test("self-heal POSTs /ensure-insights with the Bearer token when a tile is bare", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({ patchedCount: 0, dashboard: null }),
        } as unknown as Response;
      })
    );

    await act(async () => {
      renderHook(() =>
        useEnsureDashboardInsights({ id: "dash_1", charts: [{}] }, () => {})
      );
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]?.url).toBe("/api/dashboards/dash_1/ensure-insights");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("does not fire when every chart already carries an insight", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push(1);
        return { ok: true, json: async () => ({}) } as unknown as Response;
      })
    );

    await act(async () => {
      renderHook(() =>
        useEnsureDashboardInsights(
          { id: "dash_2", charts: [{ keyInsight: "already here" }] },
          () => {}
        )
      );
    });
    // Give any (incorrect) async path a chance to fire before asserting silence.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
  });
});
