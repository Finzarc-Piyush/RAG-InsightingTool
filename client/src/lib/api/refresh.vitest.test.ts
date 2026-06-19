/**
 * Wave WR8 (incremental refresh) · refresh SSE API client contract.
 *
 * Pins the request shaping + SSE parsing that the "Update data" modal depends
 * on — mocking `fetch` so we never hit the real endpoint:
 *   - `runRefreshStream` POSTs multipart FormData (file + policy + appendKey) to
 *     `/api/sessions/:id/refresh`.
 *   - `runSnowflakeRefreshStream` POSTs JSON to `…/refresh/snowflake`.
 *   - The manual SSE reader parses `event:`/`data:` frames into typed events.
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

/** Build a ReadableStream body that emits the given SSE frames then closes. */
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

describe("WR8 · runRefreshStream", () => {
  test("POSTs multipart FormData to the refresh route and parses SSE events", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          body: sseBody([
            frame("automation_progress", {
              type: "automation_progress",
              phase: "replaying_turn",
              step: 1,
              total: 2,
            }),
            frame("refresh_complete", {
              type: "refresh_complete",
              ok: true,
              dashboardId: "dash_9",
            }),
          ]),
        };
      })
    );

    const { runRefreshStream } = await import("./refresh");
    const events: string[] = [];
    let dashboardId: string | undefined;
    await new Promise<void>((resolve) => {
      runRefreshStream(
        "session_1",
        {
          file: new File(["a,b\n1,2"], "may.csv", { type: "text/csv" }),
          policy: "append",
          appendKey: ["Date", "Brand"],
        },
        {
          onEvent: (ev) => {
            events.push(ev.type);
            if (ev.type === "refresh_complete") dashboardId = ev.dashboardId;
          },
          onClose: () => resolve(),
          onError: () => resolve(),
        }
      );
    });

    expect(calls[0]?.url).toBe("/api/sessions/session_1/refresh");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = calls[0]?.init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("policy")).toBe("append");
    expect(body.get("appendKey")).toBe(JSON.stringify(["Date", "Brand"]));
    expect(body.get("file")).toBeInstanceOf(File);

    expect(events).toEqual(["automation_progress", "refresh_complete"]);
    expect(dashboardId).toBe("dash_9");
  });
});

describe("WR8 · runSnowflakeRefreshStream", () => {
  test("POSTs JSON to the snowflake refresh route", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, body: sseBody([frame("stream_end", { type: "stream_end", ok: true })]) };
      })
    );
    const { runSnowflakeRefreshStream } = await import("./refresh");
    await new Promise<void>((resolve) => {
      runSnowflakeRefreshStream(
        "session_2",
        { versionLabel: "as of May" },
        { onEvent: () => {}, onClose: () => resolve(), onError: () => resolve() }
      );
    });
    expect(calls[0]?.url).toBe("/api/sessions/session_2/refresh/snowflake");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(String(calls[0]?.init?.body)).toContain("as of May");
    expect((calls[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
  });
});
