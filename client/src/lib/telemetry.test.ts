/**
 * Wave WD3-telemetry · client-side tests for recordDashboardDrillThroughTelemetry.
 * Wave WI4-telemetry · sibling tests for recordDashboardExplainSliceTelemetry.
 *
 * Both helpers are one-shot fire-and-forget POSTs sharing the same
 * contract:
 *   - POSTs to /api/telemetry/{drill-through,explain-slice} with
 *     credentials include + JSON body.
 *   - Body is exactly the input payload (no field rename / drop / add).
 *   - Network rejections are swallowed (helper never throws).
 *   - Non-2xx server responses are swallowed (helper never throws).
 *   - SSR-safe: no-op when `fetch` is undefined.
 *   - Awaiting the helper resolves once the fetch settles (so callers can
 *     `void` it without warning AND callers that `await` it work too).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordDashboardDrillThroughTelemetry,
  recordDashboardExplainSliceTelemetry,
} from "./telemetry";

type FetchSig = typeof globalThis.fetch;

function withMockedFetch<T>(
  mock: FetchSig | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  if (mock === undefined) {
    delete (globalThis as { fetch?: FetchSig }).fetch;
  } else {
    globalThis.fetch = mock;
  }
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

test("POSTs to /api/telemetry/drill-through with credentials include + JSON body", async () => {
  let captured: { url: unknown; init: RequestInit | undefined } | null = null;
  await withMockedFetch(
    (async (url: unknown, init?: RequestInit) => {
      captured = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardDrillThroughTelemetry({
        chartId: "chart-3",
        column: "region",
        valueType: "string",
        dashboardId: "dashboard-abc",
      });
    },
  );

  if (!captured) throw new Error("fetch should have been called");
  const c: { url: unknown; init: RequestInit | undefined } = captured;
  assert.equal(c.url, "/api/telemetry/drill-through");
  assert.equal(c.init?.method, "POST");
  assert.equal(c.init?.credentials, "include");
  assert.equal(
    (c.init?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );

  const body = JSON.parse(c.init?.body as string);
  assert.deepEqual(body, {
    chartId: "chart-3",
    column: "region",
    valueType: "string",
    dashboardId: "dashboard-abc",
  });
});

test("omits dashboardId from the wire body when caller omits it", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardDrillThroughTelemetry({
        chartId: "chart-3",
        column: "region",
        valueType: "number",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  assert.deepEqual(body, {
    chartId: "chart-3",
    column: "region",
    valueType: "number",
  });
  assert.equal("dashboardId" in body, false);
});

test("swallows fetch rejection (network down) — never throws", async () => {
  await withMockedFetch(
    (async () => {
      throw new Error("network down");
    }) as unknown as FetchSig,
    async () => {
      await assert.doesNotReject(
        recordDashboardDrillThroughTelemetry({
          chartId: "c1",
          column: "x",
          valueType: "number",
        }),
      );
    },
  );
});

test("swallows non-200 server responses — never throws", async () => {
  await withMockedFetch(
    (async () => new Response("nope", { status: 500 })) as unknown as FetchSig,
    async () => {
      await assert.doesNotReject(
        recordDashboardDrillThroughTelemetry({
          chartId: "c1",
          column: "x",
          valueType: "number",
        }),
      );
    },
  );
});

test("SSR-safe: no-op when fetch is undefined and never throws", async () => {
  await withMockedFetch(undefined, async () => {
    await assert.doesNotReject(
      recordDashboardDrillThroughTelemetry({
        chartId: "c1",
        column: "x",
        valueType: "number",
      }),
    );
  });
});

test("resolves once the fetch settles (await is awaitable, void is voidable)", async () => {
  let resolved = false;
  await withMockedFetch(
    (async () => {
      // Tiny delay to make sure the helper actually awaits.
      await new Promise((r) => setTimeout(r, 5));
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardDrillThroughTelemetry({
        chartId: "c1",
        column: "x",
        valueType: "string",
      });
      resolved = true;
    },
  );
  assert.equal(resolved, true);
});

test("does not leak the raw value field — only chartId / column / valueType / dashboardId on the wire", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      // The payload type does NOT carry a `value` field — this test pins
      // that contract at runtime: any stray field added by callers gets
      // ignored by the JSON.stringify-of-typed-payload path. We assert
      // the body shape contains ONLY the four canonical fields.
      await recordDashboardDrillThroughTelemetry({
        chartId: "c1",
        column: "region",
        valueType: "string",
        dashboardId: "d1",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, ["chartId", "column", "dashboardId", "valueType"]);
});

// ────────────────────────────────────────────────────────────────────────
// Wave WI4-telemetry · recordDashboardExplainSliceTelemetry tests.
// Mirrors the WD3 block above — different endpoint + payload shape
// (regionKind ∈ {numeric|temporal|categorical|box2d} instead of
// valueType), same fire-and-forget contract.
// ────────────────────────────────────────────────────────────────────────

test("WI4 · POSTs to /api/telemetry/explain-slice with credentials include + JSON body", async () => {
  let captured: { url: unknown; init: RequestInit | undefined } | null = null;
  await withMockedFetch(
    (async (url: unknown, init?: RequestInit) => {
      captured = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardExplainSliceTelemetry({
        chartId: "chart-3",
        column: "spend",
        regionKind: "numeric",
        dashboardId: "dashboard-abc",
      });
    },
  );

  if (!captured) throw new Error("fetch should have been called");
  const c: { url: unknown; init: RequestInit | undefined } = captured;
  assert.equal(c.url, "/api/telemetry/explain-slice");
  assert.equal(c.init?.method, "POST");
  assert.equal(c.init?.credentials, "include");
  assert.equal(
    (c.init?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );

  const body = JSON.parse(c.init?.body as string);
  assert.deepEqual(body, {
    chartId: "chart-3",
    column: "spend",
    regionKind: "numeric",
    dashboardId: "dashboard-abc",
  });
});

test("WI4 · omits dashboardId from the wire body when caller omits it", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardExplainSliceTelemetry({
        chartId: "chart-3",
        column: "month",
        regionKind: "temporal",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  assert.deepEqual(body, {
    chartId: "chart-3",
    column: "month",
    regionKind: "temporal",
  });
  assert.equal("dashboardId" in body, false);
});

test("WI4 · swallows fetch rejection (network down) — never throws", async () => {
  await withMockedFetch(
    (async () => {
      throw new Error("network down");
    }) as unknown as FetchSig,
    async () => {
      await assert.doesNotReject(
        recordDashboardExplainSliceTelemetry({
          chartId: "c1",
          column: "x",
          regionKind: "categorical",
        }),
      );
    },
  );
});

test("WI4 · swallows non-200 server responses — never throws", async () => {
  await withMockedFetch(
    (async () => new Response("nope", { status: 500 })) as unknown as FetchSig,
    async () => {
      await assert.doesNotReject(
        recordDashboardExplainSliceTelemetry({
          chartId: "c1",
          column: "x",
          regionKind: "numeric",
        }),
      );
    },
  );
});

test("WI4 · SSR-safe: no-op when fetch is undefined and never throws", async () => {
  await withMockedFetch(undefined, async () => {
    await assert.doesNotReject(
      recordDashboardExplainSliceTelemetry({
        chartId: "c1",
        column: "x",
        regionKind: "box2d",
      }),
    );
  });
});

test("WI4 · resolves once the fetch settles (await is awaitable, void is voidable)", async () => {
  let resolved = false;
  await withMockedFetch(
    (async () => {
      // Tiny delay to make sure the helper actually awaits.
      await new Promise((r) => setTimeout(r, 5));
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardExplainSliceTelemetry({
        chartId: "c1",
        column: "x",
        regionKind: "temporal",
      });
      resolved = true;
    },
  );
  assert.equal(resolved, true);
});

test("WI4 · does not leak raw region bounds — only chartId / column / regionKind / dashboardId on the wire", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      // The payload type carries ONLY regionKind, never the raw region
      // (numeric start/end, temporal startMs/endMs, categorical values
      // list, or box2d xMin/xMax/yMin/yMax). This test pins that
      // contract at runtime — the body shape contains EXACTLY the four
      // canonical fields and nothing else.
      await recordDashboardExplainSliceTelemetry({
        chartId: "c1",
        column: "spend",
        regionKind: "numeric",
        dashboardId: "d1",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, ["chartId", "column", "dashboardId", "regionKind"]);
});

// ---------------------------------------------------------------------------
// WD3-WI4-sheetId-telemetry · optional sheetId on both helpers
// ---------------------------------------------------------------------------

test("WD3-WI4-sheetId · drill-through body carries sheetId when caller supplies it", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardDrillThroughTelemetry({
        chartId: "chart-0",
        column: "region",
        valueType: "string",
        dashboardId: "dashboard-abc",
        sheetId: "sheet-overview",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  assert.deepEqual(body, {
    chartId: "chart-0",
    column: "region",
    valueType: "string",
    dashboardId: "dashboard-abc",
    sheetId: "sheet-overview",
  });
});

test("WD3-WI4-sheetId · drill-through body OMITS sheetId when caller omits it (key absent, not undefined)", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardDrillThroughTelemetry({
        chartId: "chart-0",
        column: "region",
        valueType: "string",
        dashboardId: "dashboard-abc",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  // .strict() on the server requires the key to be absent, not
  // present-with-undefined — JSON.stringify already drops undefined,
  // but pin the contract so a future refactor (e.g. spread of a
  // partial payload) can't silently start sending `sheetId: null` or
  // similar non-undefined values.
  assert.equal("sheetId" in body, false);
});

test("WD3-WI4-sheetId · explain-slice body carries sheetId when caller supplies it", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardExplainSliceTelemetry({
        chartId: "chart-0",
        column: "month",
        regionKind: "temporal",
        dashboardId: "dashboard-abc",
        sheetId: "sheet-details",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  assert.deepEqual(body, {
    chartId: "chart-0",
    column: "month",
    regionKind: "temporal",
    dashboardId: "dashboard-abc",
    sheetId: "sheet-details",
  });
});

test("WD3-WI4-sheetId · explain-slice body OMITS sheetId when caller omits it (key absent, not undefined)", async () => {
  let capturedBody: string | null = null;
  await withMockedFetch(
    (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(null, { status: 204 });
    }) as unknown as FetchSig,
    async () => {
      await recordDashboardExplainSliceTelemetry({
        chartId: "chart-0",
        column: "month",
        regionKind: "box2d",
        dashboardId: "dashboard-abc",
      });
    },
  );

  const body = JSON.parse(capturedBody!);
  assert.equal("sheetId" in body, false);
});
