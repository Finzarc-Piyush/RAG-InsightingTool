import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadQueue } from "../utils/uploadQueue.js";
import { getUploadStatus } from "../controllers/uploadController.js";
import type { Request, Response } from "express";

/**
 * EX1 / SEC-1 regression — cross-tenant IDOR on GET /api/upload/status/:jobId.
 *
 * Before the fix, getUploadStatus did `uploadQueue.getJob(jobId)` with NO
 * ownership check and returned the job's sessionId, dataset column schema,
 * row counts, and LLM-suggested questions to ANY authenticated caller — and
 * jobIds were guessable (Date.now() + Math.random()). These tests pin the two
 * security properties that close it: (1) authentication is required, and
 * (2) a caller can only see their own job (cross-tenant requests get an
 * existence-hiding 404, not the payload). Both paths short-circuit before the
 * Cosmos session fetch, so the test is hermetic.
 */

function makeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200 as number,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const OWNER_JOB = {
  jobId: "job_secret",
  sessionId: "session_belongs_to_owner",
  status: "completed",
  progress: 100,
  createdAt: 1_700_000_000_000,
  username: "owner@example.com",
};

async function withMockedJob(job: unknown, run: () => Promise<void>) {
  const original = uploadQueue.getJob;
  (uploadQueue as unknown as { getJob: unknown }).getJob = () => job;
  try {
    await run();
  } finally {
    (uploadQueue as unknown as { getJob: unknown }).getJob = original;
  }
}

test("SEC-1: a different tenant gets 404 (not the owner's dataset metadata)", async () => {
  await withMockedJob(OWNER_JOB, async () => {
    const req = {
      params: { jobId: "job_secret" },
      headers: {},
      auth: { email: "attacker@example.com" },
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 404, "cross-tenant request must be rejected");
    assert.deepEqual(
      res.body,
      { error: "Job not found" },
      "must not leak sessionId / schema / suggested questions",
    );
  });
});

test("SEC-1: unauthenticated request gets 401", async () => {
  await withMockedJob(OWNER_JOB, async () => {
    const req = {
      params: { jobId: "job_secret" },
      headers: {},
    } as unknown as Request;
    const res = makeRes();
    await getUploadStatus(req, res);
    assert.equal(res.statusCode, 401, "missing identity must be rejected");
  });
});

// NOTE: the owner-success path is intentionally NOT exercised here — after the
// ownership gate, getUploadStatus does a dynamic import of chat.model and a
// Cosmos read, which is not hermetic in a unit test. The two tests above pin
// the security-relevant behaviour (the gate itself). Case-insensitive matching
// of owner vs requester is covered by the trim().toLowerCase() on both sides.
