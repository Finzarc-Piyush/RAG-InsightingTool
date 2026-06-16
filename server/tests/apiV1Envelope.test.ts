import { test } from "node:test";
import assert from "node:assert/strict";
import express, { Router } from "express";
import type { AddressInfo } from "node:net";
import { apiV1Envelope } from "../middleware/apiV1Envelope.js";

/**
 * API-4 · The `/api/v1` alias wraps JSON in the standard envelope
 * (`{ data }` on success, `{ error: {…} }` on failure) while the
 * unversioned `/api` route stays byte-identical (raw shape). We reproduce the
 * real wiring: a stub router mounted under BOTH prefixes (like routes/index.ts
 * `mount`), with `apiV1Envelope` mounted on `/api/v1` only.
 */
function buildApp() {
  const app = express();

  const stub = Router();
  stub.get("/widgets", (_req, res) => {
    // bespoke raw shape, exactly like existing routes
    res.json({ widgets: [{ id: 1 }], count: 1 });
  });
  stub.get("/boom", (_req, res) => {
    res.status(404).json({ error: "widget_not_found" });
  });
  stub.get("/stream", (_req, res) => {
    // SSE-style response must NOT be enveloped.
    res.setHeader("Content-Type", "text/event-stream");
    res.json({ tick: 1 });
  });
  stub.get("/already", (_req, res) => {
    // handler that already adopted the envelope helpers — no double-wrap.
    res.json({ data: { adopted: true } });
  });

  // Same mechanism as routes/index.ts: envelope on v1 first, then both mounts.
  app.use("/api/v1", apiV1Envelope);
  app.use("/api", stub);
  app.use("/api/v1", stub);

  return app;
}

async function withServer(fn: (base: string) => Promise<void>) {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("v1 success is enveloped as { data }; unversioned stays raw", async () => {
  await withServer(async (base) => {
    const rawRes = await fetch(`${base}/api/widgets`);
    const raw = await rawRes.json();
    assert.deepEqual(raw, { widgets: [{ id: 1 }], count: 1 });

    const v1Res = await fetch(`${base}/api/v1/widgets`);
    const v1 = await v1Res.json();
    assert.deepEqual(v1, { data: { widgets: [{ id: 1 }], count: 1 } });
  });
});

test("v1 error (>=400) is enveloped as { error: { code, message } }; unversioned stays raw", async () => {
  await withServer(async (base) => {
    const rawRes = await fetch(`${base}/api/boom`);
    assert.equal(rawRes.status, 404);
    assert.deepEqual(await rawRes.json(), { error: "widget_not_found" });

    const v1Res = await fetch(`${base}/api/v1/boom`);
    assert.equal(v1Res.status, 404);
    const v1 = (await v1Res.json()) as { error: { code: string; message: string } };
    assert.equal(v1.error.code, "http_404");
    assert.equal(v1.error.message, "widget_not_found");
  });
});

test("v1 SSE (text/event-stream) is NOT enveloped", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/stream`);
    assert.deepEqual(await res.json(), { tick: 1 });
  });
});

test("v1 payload already in envelope shape is NOT double-wrapped", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/already`);
    assert.deepEqual(await res.json(), { data: { adopted: true } });
  });
});
