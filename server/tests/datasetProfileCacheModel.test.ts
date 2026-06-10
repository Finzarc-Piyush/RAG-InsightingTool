// Wave W-DPC1 · datasetProfileCache.model behavioural tests
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  readCachedProfile,
  writeCachedProfile,
  computeContextHash,
  __docIdForTesting,
  __setContainerForTesting,
  DATASET_PROFILE_CACHE_SCHEMA_VERSION,
} from "../models/datasetProfileCache.model.js";
import {
  datasetProfileCacheDocSchema,
  type DatasetProfile,
} from "../shared/schema.js";

/** Minimal in-memory Cosmos container stub (keys by doc id only). */
function createStubContainer() {
  const store = new Map<string, unknown>();
  const stub = {
    item(id: string, _partition: string) {
      return {
        async read<T>(): Promise<{ resource: T | undefined }> {
          return { resource: store.get(id) as T | undefined };
        },
      };
    },
    items: {
      async upsert(doc: unknown) {
        const parsed = datasetProfileCacheDocSchema.parse(doc);
        store.set(parsed.id, parsed);
        return parsed;
      },
    },
    __store: store,
  };
  return stub;
}

const profile: DatasetProfile = {
  shortDescription: "Monthly sales by region",
  dateColumns: ["Month"],
  suggestedQuestions: ["What is the monthly sales trend?"],
};

let stub: ReturnType<typeof createStubContainer>;

beforeEach(() => {
  stub = createStubContainer();
  __setContainerForTesting(stub);
});

afterEach(() => {
  __setContainerForTesting(null);
});

describe("W-DPC1 · computeContextHash", () => {
  it("is stable for identical inputs", () => {
    assert.equal(computeContextHash("a", "b"), computeContextHash("a", "b"));
  });
  it("treats undefined and empty string identically", () => {
    assert.equal(computeContextHash(), computeContextHash("", ""));
  });
  it("changes when permanentContext changes", () => {
    assert.notEqual(computeContextHash("a", "b"), computeContextHash("a2", "b"));
  });
  it("changes when domainContext changes", () => {
    assert.notEqual(computeContextHash("a", "b"), computeContextHash("a", "b2"));
  });
  it("does not collide across the field boundary (separator matters)", () => {
    assert.notEqual(computeContextHash("a", "b"), computeContextHash("ab", ""));
  });
});

describe("W-DPC1 · doc id", () => {
  it("is `${username}__${fingerprint}` (username lowercased)", () => {
    assert.equal(__docIdForTesting("Alice@X.com", "fp1"), "alice@x.com__fp1");
  });
});

describe("W-DPC1 · write → read round-trip", () => {
  it("returns the cached profile on a matching key + contextHash", async () => {
    const ctx = computeContextHash("notes", "domain");
    await writeCachedProfile("u@x", "fp1", ctx, profile);
    const got = await readCachedProfile("u@x", "fp1", ctx);
    assert.deepEqual(got, profile);
  });
});

describe("W-DPC1 · misses", () => {
  it("returns null for an unknown key (404-equivalent)", async () => {
    const got = await readCachedProfile("u@x", "nope", computeContextHash());
    assert.equal(got, null);
  });

  it("returns null when the contextHash differs (context changed)", async () => {
    await writeCachedProfile("u@x", "fp1", computeContextHash("old"), profile);
    const got = await readCachedProfile("u@x", "fp1", computeContextHash("new"));
    assert.equal(got, null);
  });

  it("returns null when the stored schemaVersion is stale", async () => {
    const ctx = computeContextHash("notes");
    const id = __docIdForTesting("u@x", "fp1");
    // Seed a doc with a newer/stale schemaVersion directly into the store.
    stub.__store.set(id, {
      id,
      username: "u@x",
      datasetFingerprint: "fp1",
      contextHash: ctx,
      schemaVersion: DATASET_PROFILE_CACHE_SCHEMA_VERSION + 1,
      profile,
      updatedAt: 1,
    });
    const got = await readCachedProfile("u@x", "fp1", ctx);
    assert.equal(got, null);
  });
});

describe("W-DPC1 · per-user isolation", () => {
  it("user A's cache does not leak to user B", async () => {
    const ctx = computeContextHash();
    await writeCachedProfile("alice@x", "fp1", ctx, profile);
    assert.deepEqual(await readCachedProfile("alice@x", "fp1", ctx), profile);
    assert.equal(await readCachedProfile("bob@x", "fp1", ctx), null);
  });
});
