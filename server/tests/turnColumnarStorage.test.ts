/**
 * PERF-10 · Per-turn shared DuckDB handle.
 *
 * Locks in the three behaviours the agent loop relies on:
 *   1. Memoisation — the first adopter constructs + initializes one handle; a
 *      second call in the same turn returns the SAME instance (no re-open).
 *   2. Close-once — closeTurnColumnarStorage closes it and clears the cache;
 *      a second close is a no-op (idempotent).
 *   3. Isolation — a session-mismatched request bypasses the cache and returns
 *      a fresh, caller-owned handle.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import {
  ColumnarStorageService,
  initDuckDBEager,
  isDuckDBAvailable,
} from "../lib/columnarStorage.js";
import {
  getTurnColumnarStorage,
  closeTurnColumnarStorage,
  type TurnColumnarStorageCtx,
} from "../lib/agents/runtime/turnColumnarStorage.js";

const tempDir = path.join(os.tmpdir(), `marico-perf10-${Date.now()}`);

/** Minimal ctx-shaped object — the helpers only read sessionId + the cache. */
function makeCtx(sessionId: string): TurnColumnarStorageCtx {
  return { sessionId };
}

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe("turnColumnarStorage (PERF-10 shared per-turn handle)", () => {
  it("memoises one handle per turn and returns the same instance", async (t) => {
    await initDuckDBEager();
    if (!isDuckDBAvailable()) {
      t.skip("DuckDB not installed in this environment");
      return;
    }
    const ctx = makeCtx("perf10-memoise");
    const a = await getTurnColumnarStorage(ctx);
    const b = await getTurnColumnarStorage(ctx);
    assert.equal(a.shared, true);
    assert.equal(b.shared, true);
    assert.equal(a.storage, b.storage, "second adopter must reuse the instance");
    assert.ok(ctx._turnColumnarStorage, "cache must be stashed on ctx");
    await closeTurnColumnarStorage(ctx);
  });

  it("closes once and clears the cache; second close is a no-op", async (t) => {
    await initDuckDBEager();
    if (!isDuckDBAvailable()) {
      t.skip("DuckDB not installed in this environment");
      return;
    }
    const ctx = makeCtx("perf10-close");
    const { storage } = await getTurnColumnarStorage(ctx);
    let closeCount = 0;
    const realClose = storage.close.bind(storage);
    storage.close = async () => {
      closeCount++;
      return realClose();
    };
    await closeTurnColumnarStorage(ctx);
    assert.equal(closeCount, 1, "handle closed exactly once");
    assert.equal(ctx._turnColumnarStorage, undefined, "cache cleared");
    // Idempotent: closing again with no cache must not throw or re-close.
    await closeTurnColumnarStorage(ctx);
    assert.equal(closeCount, 1, "second close is a no-op");
  });

  it("close is a no-op when no adopter ever asked for a handle", async () => {
    const ctx = makeCtx("perf10-never-opened");
    await closeTurnColumnarStorage(ctx); // must not throw
    assert.equal(ctx._turnColumnarStorage, undefined);
  });

  it("a custom tempDir request is NOT shared (caller owns it)", async (t) => {
    await initDuckDBEager();
    if (!isDuckDBAvailable()) {
      t.skip("DuckDB not installed in this environment");
      return;
    }
    const ctx = makeCtx("perf10-tempdir");
    const { storage, shared } = await getTurnColumnarStorage(ctx, { tempDir });
    assert.equal(shared, false, "explicit tempDir bypasses the shared cache");
    assert.equal(
      ctx._turnColumnarStorage,
      undefined,
      "throwaway handle must not be cached on ctx"
    );
    await storage.close();
  });

  it("shared handle answers queries across multiple adopters in one turn", async (t) => {
    await initDuckDBEager();
    if (!isDuckDBAvailable()) {
      t.skip("DuckDB not installed in this environment");
      return;
    }
    const sessionId = "perf10-e2e";
    // Materialize a tiny session table on its own handle (simulates upload).
    const seed = new ColumnarStorageService({ sessionId, tempDir });
    await seed.initialize();
    await seed.materializeAuthoritativeDataTable(
      [
        { region: "North", sales: 10 },
        { region: "South", sales: 20 },
      ],
      { tableName: "data" }
    );
    await seed.close();

    // Adopters re-open the SAME .duckdb file via the shared-cache helper. Use
    // the same tempDir override on a per-call basis so both adopters point at
    // the seeded file; they get throwaway handles (shared=false) but still
    // prove the data is visible. (The shared path itself is covered above.)
    const ctx = makeCtx(sessionId);
    const first = await getTurnColumnarStorage(ctx, { tempDir });
    const rowsA = await first.storage.executeQuery<{ c: number }>(
      "SELECT COUNT(*)::INT AS c FROM data"
    );
    assert.equal(Number(rowsA[0]?.c), 2);
    await first.storage.close();

    const second = await getTurnColumnarStorage(ctx, { tempDir });
    const rowsB = await second.storage.executeQuery<{ s: number }>(
      "SELECT SUM(sales)::INT AS s FROM data"
    );
    assert.equal(Number(rowsB[0]?.s), 30);
    await second.storage.close();
  });
});
