// EX4 / OBS-1 · structured, correlated logging.
// Set LOG_FORMAT before importing the logger (it resolves the mode once at
// module load). node:test runs each file in its own process, so this env set
// does not leak into other suites.
process.env.LOG_FORMAT = "json";

import { test } from "node:test";
import assert from "node:assert/strict";

test("OBS-1: structured logger emits one JSON line with the message", async () => {
  const { logger } = await import("../lib/logger.js");
  const captured: string[] = [];
  const orig = console.info;
  console.info = (...a: unknown[]) => {
    captured.push(String(a[0]));
  };
  try {
    logger.info("hello world", { k: 1 });
  } finally {
    console.info = orig;
  }
  assert.equal(captured.length, 1);
  const obj = JSON.parse(captured[0]);
  assert.equal(obj.level, "info");
  assert.ok(typeof obj.ts === "string" && obj.ts.length > 0);
  assert.match(obj.msg, /hello world/);
  assert.match(obj.msg, /"k":1/);
});

test("OBS-1: correlation fields (traceId/sessionId/userId) are merged from request context", async () => {
  const { logger } = await import("../lib/logger.js");
  const { withRequestContext } = await import("../lib/telemetry/requestContext.js");
  const captured: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    captured.push(String(a[0]));
  };
  try {
    withRequestContext(
      { traceId: "t-123", sessionId: "s-abc", userId: "u@example.com", turnId: "turn-1" },
      () => {
        logger.error("boom");
      },
    );
  } finally {
    console.error = orig;
  }
  assert.equal(captured.length, 1);
  const obj = JSON.parse(captured[0]);
  assert.equal(obj.traceId, "t-123");
  assert.equal(obj.sessionId, "s-abc");
  assert.equal(obj.userId, "u@example.com");
  assert.equal(obj.turnId, "turn-1");
  assert.equal(obj.level, "error");
});
