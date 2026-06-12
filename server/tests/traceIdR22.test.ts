import { test } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import {
  withRequestContext,
  getRequestContext,
} from "../lib/telemetry/requestContext.js";
import { sendSSE } from "../utils/sse.helper.js";

/**
 * Wave R22 · per-turn traceId propagation: bound via AsyncLocalStorage at the
 * stream entry, surfaced on SSE frames via the protocol `id:` field (so it
 * never collides with the event-`data` schema).
 */
function mockRes(): Response & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    writableEnded: false,
    destroyed: false,
    writable: true,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as Response & { writes: string[] };
}

test("withRequestContext binds traceId for getRequestContext, scoped", () => {
  withRequestContext({ traceId: "trace-abc", sessionId: "s1" }, () => {
    assert.equal(getRequestContext().traceId, "trace-abc");
    assert.equal(getRequestContext().sessionId, "s1");
  });
  assert.equal(getRequestContext().traceId, undefined); // not bound outside
});

test("sendSSE stamps the traceId on the SSE id: line (not in data)", () => {
  const res = mockRes();
  withRequestContext({ traceId: "trace-xyz" }, () => {
    sendSSE(res, "trace_test_event", { text: "hi" });
  });
  const frame = res.writes.join("");
  assert.match(frame, /^id: trace-xyz\n/);
  assert.match(frame, /\nevent: trace_test_event\n/);
  assert.match(frame, /\ndata: \{"text":"hi"\}\n/);
  // traceId must NOT leak into the data JSON.
  assert.ok(!/"traceId"/.test(frame));
});

test("sendSSE omits the id: line when no traceId is bound", () => {
  const res = mockRes();
  sendSSE(res, "trace_test_event", { text: "hi" });
  const frame = res.writes.join("");
  assert.ok(!frame.startsWith("id:"), "no id: line without a traceId");
  assert.match(frame, /^event: trace_test_event\n/);
});
