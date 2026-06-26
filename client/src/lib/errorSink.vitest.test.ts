/**
 * Wave W-INS2 · the client error sink uses raw `fetch`, so it must attach the
 * Bearer token — via the *silent* helper, because it runs from global error
 * handlers (often when auth is itself broken) and must NEVER pop a re-auth
 * window or cascade into another error. See docs/conventions/authed-raw-fetch.md.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/auth/msalToken", () => ({
  getAuthorizationHeaderSilent: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe("OBS-6 · client error sink auth", () => {
  test("reportClientError attaches the silent Bearer token + keepalive", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true } as unknown as Response;
      })
    );

    const { reportClientError } = await import("./errorSink");
    await reportClientError({ message: "boom", source: "test" });

    expect(calls[0]?.url).toBe("/api/client-error");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.init?.keepalive).toBe(true);
  });

  test("never throws when the network fails (must not cascade the global handler)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const { reportClientError } = await import("./errorSink");
    await expect(reportClientError({ message: "boom" })).resolves.toBeUndefined();
  });
});
