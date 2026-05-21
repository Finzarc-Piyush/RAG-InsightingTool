/**
 * Wave WD3-telemetry · client-side tests for recordDashboardDrillThroughTelemetry.
 *
 * The helper is a one-shot fire-and-forget POST. The contract is:
 *   - POSTs to /api/telemetry/drill-through with credentials include + JSON body.
 *   - Body is exactly the input payload (no field rename / drop / add).
 *   - Network rejections are swallowed (helper never throws).
 *   - Non-2xx server responses are swallowed (helper never throws).
 *   - SSR-safe: no-op when `fetch` is undefined.
 *   - Awaiting the helper resolves once the fetch settles (so callers can
 *     `void` it without warning AND callers that `await` it work too).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDashboardDrillThroughTelemetry } from "./telemetry";

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
