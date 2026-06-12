import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureException,
  captureMessage,
  isCrashReporterActive,
  initCrashReporter,
  __resetCrashReporterForTesting,
} from "../lib/observability/crashReporter.js";

/**
 * Wave R23 · crash reporting is a no-op unless @sentry/node is installed AND
 * SENTRY_DSN is set — and must NEVER throw (crash reporting can't cause crashes).
 */

test("inactive (no-op) without SENTRY_DSN", async () => {
  __resetCrashReporterForTesting();
  const prev = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  try {
    await initCrashReporter();
    assert.equal(isCrashReporterActive(), false);
    assert.doesNotThrow(() => captureException(new Error("x"), { source: "test" }));
    assert.doesNotThrow(() => captureMessage("msg", "warning"));
  } finally {
    if (prev !== undefined) process.env.SENTRY_DSN = prev;
    __resetCrashReporterForTesting();
  }
});

test("DSN set but @sentry/node not installed → degrades gracefully (stays inactive, no throw)", async () => {
  __resetCrashReporterForTesting();
  const prev = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = "https://fake@example.ingest.sentry.io/123";
  try {
    await initCrashReporter();
    assert.equal(isCrashReporterActive(), false);
    assert.doesNotThrow(() => captureException(new Error("y")));
  } finally {
    if (prev !== undefined) process.env.SENTRY_DSN = prev;
    else delete process.env.SENTRY_DSN;
    __resetCrashReporterForTesting();
  }
});
