/**
 * Wave W-INS2 · the telemetry beacons use raw `fetch` and so must attach the
 * Bearer token — but via the *silent* helper, so a background ping can NEVER
 * pop a re-auth window. Pin both the header and the never-throws invariant.
 * See docs/conventions/authed-raw-fetch.md.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/auth/msalToken", () => ({
  getAuthorizationHeaderSilent: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));

import {
  recordDashboardDrillThroughTelemetry,
  recordDashboardExplainSliceTelemetry,
} from "./telemetry";
import { getAuthorizationHeaderSilent } from "@/auth/msalToken";

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("WD3/WI4 · telemetry auth", () => {
  test("drill-through beacon attaches the silent Bearer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true } as unknown as Response;
      })
    );

    await recordDashboardDrillThroughTelemetry({
      chartId: "c1",
      column: "HQ Name",
      valueType: "string",
    });

    expect(calls[0]?.url).toBe("/api/telemetry/drill-through");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test");
    expect(headers["Content-Type"]).toBe("application/json");
    // Crucially the SILENT helper — a background beacon must never pop a window.
    expect(getAuthorizationHeaderSilent).toHaveBeenCalled();
  });

  test("explain-slice beacon attaches the silent Bearer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true } as unknown as Response;
      })
    );

    await recordDashboardExplainSliceTelemetry({
      chartId: "c1",
      column: "HQ Name",
      regionKind: "categorical",
    });

    expect(calls[0]?.url).toBe("/api/telemetry/explain-slice");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test"
    );
  });

  test("never throws when the network fails (telemetry must not break the flow)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    await expect(
      recordDashboardDrillThroughTelemetry({
        chartId: "c1",
        column: "x",
        valueType: "number",
      })
    ).resolves.toBeUndefined();
  });
});
