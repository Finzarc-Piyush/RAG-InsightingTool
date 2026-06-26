/**
 * Wave W-INS2 · the automation replay stream (`runAutomationStream`) uses raw
 * `fetch`, which bypasses the axios `apiClient` auth interceptor — so it must
 * spread `getAuthorizationHeader()` or the server 401s. Pin that the Bearer
 * token reaches the wire. See docs/conventions/authed-raw-fetch.md.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

vi.mock("@/auth/msalToken", () => ({
  getAuthorizationHeader: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));
vi.mock("@/utils/userStorage", () => ({
  getUserEmail: vi.fn(() => "user@example.com"),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
}));

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("A9 · runAutomationStream auth", () => {
  test("POSTs the run route with the Bearer token + Content-Type", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          body: sseBody([frame("stream_end", { type: "stream_end", ok: true })]),
        };
      })
    );

    const { runAutomationStream } = await import("./automations");
    await new Promise<void>((resolve) => {
      runAutomationStream(
        "auto_1",
        { sessionId: "s1" },
        { onEvent: () => {}, onClose: () => resolve(), onError: () => resolve() }
      );
    });

    expect(calls[0]?.url).toBe("/api/automations/auto_1/run");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("resume variant hits the /run/resume route, also authed", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          body: sseBody([frame("stream_end", { type: "stream_end", ok: true })]),
        };
      })
    );

    const { runAutomationStream } = await import("./automations");
    await new Promise<void>((resolve) => {
      runAutomationStream(
        "auto_2",
        { sessionId: "s1", resumeFromOrdinal: 3 },
        { onEvent: () => {}, onClose: () => resolve(), onError: () => resolve() }
      );
    });

    expect(calls[0]?.url).toBe("/api/automations/auto_2/run/resume");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test");
  });
});
