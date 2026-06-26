/**
 * Wave W-INS1 · behavioural proof that the dashboard insight-regen path
 * attaches the MSAL Bearer token.
 *
 * The hook uses raw `fetch`, which bypasses the axios `apiClient` request
 * interceptor that normally injects auth — so without an explicit
 * `getAuthorizationHeader()` spread the server's `requireAzureAdAuth`
 * middleware 401s with "Missing Authorization: Bearer token or access_token
 * query". This test mocks the token helper + global fetch and asserts the
 * outgoing request actually carries the `Authorization` header.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/auth/msalToken", () => ({
  getAuthorizationHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));

import { useInsightRegen } from "./useInsightRegen";

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("W-INS1 · useInsightRegen auth header", () => {
  test("regenerate() POSTs /api/insight/regen with the Bearer token attached", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            text: "insight body",
            regeneratedAt: "2026-06-26T00:00:00.000Z",
            confidenceTier: "high",
          }),
        } as unknown as Response;
      })
    );

    const { result } = renderHook(() =>
      useInsightRegen({ tileId: "tile_1", filters: {} })
    );

    let returned: { text?: string } | null = null;
    await act(async () => {
      returned = await result.current.regenerate(
        { type: "bar", x: "HQ Name", y: "value" },
        [{ "HQ Name": "Bangalore 1 HQ", value: 12 }]
      );
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/insight/regen");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("include");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(returned).not.toBeNull();
    expect(returned!.text).toBe("insight body");
  });
});
