import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  __sessionWriteChainSizeForTesting,
  __resetSessionWriteChainForTesting,
  withSessionWriteLock,
} from "../lib/sessionWriteLock.js";

/**
 * Wave A4 · Pins that `saveModifiedData` (the helper that powers
 * `add_computed_columns(persistToSession:true)` and every other dataOps
 * persist path in the orchestrator) acquires the unified per-session
 * write lock from Wave A2.
 *
 * Pre-A4 the computed-column persist did a get-mutate-upsert without any
 * lock; concurrent turn-end `persistMergeAssistantSessionContext` could
 * read the doc state, mutate sessionAnalysisContext, and upsert AFTER
 * the computed-column write — silently dropping the new column from
 * `dataSummary.columns`.
 *
 * Real Cosmos calls would require integration test infra; we pin the
 * contract via source-level inspection plus the lock primitive's own
 * isolation tests (covered in `sessionWriteLockA2.test.ts`).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataPersistenceSrc = resolve(
  __dirname,
  "..",
  "lib",
  "dataOps",
  "dataPersistence.ts"
);

afterEach(() => {
  __resetSessionWriteChainForTesting();
});

describe("Wave A4 · saveModifiedData uses withSessionWriteLock", () => {
  it("dataPersistence.ts source imports withSessionWriteLock from the unified module", () => {
    const src = readFileSync(dataPersistenceSrc, "utf8");
    assert.match(
      src,
      /import\s*\{\s*withSessionWriteLock\s*\}\s*from\s*['"]\.\.\/sessionWriteLock\.js['"]/,
      "dataPersistence.ts must import withSessionWriteLock from the unified module"
    );
  });

  it("saveModifiedData wraps its body in withSessionWriteLock(sessionId, ...)", () => {
    const src = readFileSync(dataPersistenceSrc, "utf8");
    // Regex tolerates whitespace + the inner helper name.
    assert.match(
      src,
      /export\s+async\s+function\s+saveModifiedData[\s\S]{0,1500}withSessionWriteLock\s*\(\s*sessionId\s*,/,
      "saveModifiedData must call withSessionWriteLock(sessionId, ...) at the top of its body"
    );
  });

  it("the locked-body helper is internal (not exported)", () => {
    const src = readFileSync(dataPersistenceSrc, "utf8");
    // The helper that runs INSIDE the lock should be NOT exported, so no
    // future caller bypasses the lock by reaching into the internals.
    assert.match(
      src,
      /^async\s+function\s+saveModifiedDataLocked/m,
      "the locked-body helper must be a non-exported `async function saveModifiedDataLocked`"
    );
    assert.doesNotMatch(
      src,
      /export\s+async\s+function\s+saveModifiedDataLocked/,
      "the locked-body helper must NOT be exported"
    );
  });
});

describe("Wave A4 · per-session isolation behavioural sanity", () => {
  it("two distinct sessions hold INDEPENDENT lock entries (proven via size counter)", async () => {
    // Verify the per-session isolation contract directly via the lock
    // primitive (Wave A2's withSessionWriteLock is the surface A4 hooks into).
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const blockerA = new Promise<void>((r) => {
      releaseA = r;
    });
    const blockerB = new Promise<void>((r) => {
      releaseB = r;
    });
    const lockA = withSessionWriteLock("sess_A4_a", async () => {
      await blockerA;
    });
    const lockB = withSessionWriteLock("sess_A4_b", async () => {
      await blockerB;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      __sessionWriteChainSizeForTesting() >= 2,
      `expected 2 distinct in-flight session locks; got ${__sessionWriteChainSizeForTesting()}`
    );
    releaseA!();
    releaseB!();
    await Promise.all([lockA, lockB]);
    assert.equal(__sessionWriteChainSizeForTesting(), 0);
  });
});
