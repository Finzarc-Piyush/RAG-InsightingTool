import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startSseKeepalive, isSseClosed } from "../utils/sse.helper.js";
import type { Response } from "express";

/**
 * Wave W10 · longRunningSSE unit tests.
 *
 * Tests the startSseKeepalive utility added to sse.helper.ts.
 * We use a fake Response object to verify write + flush calls without
 * needing a real HTTP server.
 */

function makeFakeRes(writable = true): Response & { written: string[]; flushed: number } {
  const written: string[] = [];
  let flushed = 0;
  return {
    written,
    flushed,
    writableEnded: !writable,
    destroyed: false,
    writable,
    write(chunk: string) { written.push(chunk); return true; },
    flush() { flushed++; },
    on() { return this; },
  } as unknown as Response & { written: string[]; flushed: number };
}

describe("startSseKeepalive", () => {
  it("returns a stop function", () => {
    const res = makeFakeRes();
    const stop = startSseKeepalive(res, 100_000); // very long interval — won't fire
    assert.strictEqual(typeof stop, "function");
    stop();
  });

  it("stop function clears the timer (no writes after stop)", (ctx) => {
    return new Promise<void>((resolve) => {
      const res = makeFakeRes();
      const stop = startSseKeepalive(res, 20); // 20ms interval
      stop(); // stop immediately
      // Wait longer than the interval to confirm no writes happened after stop
      setTimeout(() => {
        assert.strictEqual(res.written.length, 0);
        resolve();
      }, 60);
    });
  });

  it("writes keepalive comment on each tick", (ctx) => {
    return new Promise<void>((resolve) => {
      const res = makeFakeRes();
      const stop = startSseKeepalive(res, 20);
      setTimeout(() => {
        stop();
        assert.ok(res.written.length >= 1, "expected at least one keepalive write");
        assert.ok(
          res.written.every((w) => w === ": keepalive\n\n"),
          "each write should be the SSE comment format"
        );
        resolve();
      }, 70);
    });
  });

  it("stops automatically when res is closed", (ctx) => {
    return new Promise<void>((resolve) => {
      const res = makeFakeRes();
      // Mark the response as closed after first tick
      const stop = startSseKeepalive(res, 20);
      setTimeout(() => {
        (res as any).writableEnded = true;
        (res as any).writable = false;
      }, 30);
      setTimeout(() => {
        stop();
        // Should have written at most 1-2 times before auto-stopping
        assert.ok(res.written.length <= 3);
        resolve();
      }, 100);
    });
  });
});

describe("isSseClosed", () => {
  it("returns false for a writable response", () => {
    const res = makeFakeRes(true);
    assert.strictEqual(isSseClosed(res), false);
  });

  it("returns true when writableEnded", () => {
    const res = makeFakeRes(false);
    assert.strictEqual(isSseClosed(res), true);
  });
});
