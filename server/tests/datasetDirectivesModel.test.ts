// Wave W-UD2 · datasetDirectives.model end-to-end behavioural tests
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendDirective,
  revokeDirective,
  listActiveDirectives,
  getDatasetDirectivesDoc,
  __setContainerForTesting,
  __lockKeyForTesting,
  __generateDirectiveIdForTesting,
  __docIdForTesting,
} from "../models/datasetDirectives.model.js";
import {
  __resetSessionWriteChainForTesting,
} from "../lib/sessionWriteLock.js";
import { datasetDirectivesDocSchema } from "../shared/schema.js";

/** Minimal in-memory Cosmos container stub. */
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
        const parsed = datasetDirectivesDocSchema.parse(doc);
        store.set(parsed.id, parsed);
        return parsed;
      },
    },
    __store: store,
  };
  return stub;
}

let stub: ReturnType<typeof createStubContainer>;

beforeEach(() => {
  stub = createStubContainer();
  __setContainerForTesting(stub);
  __resetSessionWriteChainForTesting();
});

afterEach(() => {
  __setContainerForTesting(null);
  __resetSessionWriteChainForTesting();
});

describe("W-UD2 · helpers", () => {
  it("docId is `${username}__${fingerprint}` (username lowercased)", () => {
    assert.equal(
      __docIdForTesting("Alice@Example.com", "abc1234567890def"),
      "alice@example.com__abc1234567890def"
    );
  });

  it("lock key is scoped per (username, fingerprint), distinct from a session lock", () => {
    const a = __lockKeyForTesting("u@x", "fp1");
    const b = __lockKeyForTesting("u@x", "fp2");
    const c = __lockKeyForTesting("v@x", "fp1");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^dataset_directives::u@x::fp1$/);
  });

  it("generated directive id has the timestamp-random shape", () => {
    const id = __generateDirectiveIdForTesting();
    assert.match(id, /^[0-9a-z]{8}-[0-9a-f]{1,18}$/);
  });
});

describe("W-UD2 · getDatasetDirectivesDoc", () => {
  it("returns an empty shape for a fresh dataset (no record yet)", async () => {
    const doc = await getDatasetDirectivesDoc("u@x", "fp1");
    assert.equal(doc.directives.length, 0);
    assert.equal(doc.version, 0);
    assert.equal(doc.id, "u@x__fp1");
    assert.equal(doc.username, "u@x");
  });
});

describe("W-UD2 · appendDirective", () => {
  it("appends an active directive and bumps the version", async () => {
    const { directive, doc } = await appendDirective("u@x", "fp1", {
      kind: "exclude",
      text: "from now on omit Hair Oil",
      source: "chat-message",
      sourceSessionId: "sess-1",
    });
    assert.equal(directive.status, "active");
    assert.equal(directive.scope, "dataset", "default scope is 'dataset'");
    assert.equal(doc.version, 1);
    assert.equal(doc.directives.length, 1);
  });

  it("supersedes the prior active directive when supersedes ids are provided", async () => {
    const first = await appendDirective("u@x", "fp1", {
      kind: "exclude",
      text: "omit Hair Oil",
      source: "chat-message",
    });
    const second = await appendDirective("u@x", "fp1", {
      kind: "include-only",
      text: "actually include Hair Oil from now on",
      source: "chat-message",
      supersedes: [first.directive.id],
    });
    const finalDoc = await getDatasetDirectivesDoc("u@x", "fp1");
    const oldEntry = finalDoc.directives.find((d) => d.id === first.directive.id);
    const newEntry = finalDoc.directives.find((d) => d.id === second.directive.id);
    assert.equal(oldEntry?.status, "superseded");
    assert.equal(oldEntry?.supersededBy, second.directive.id);
    assert.equal(newEntry?.status, "active");
    assert.deepEqual(newEntry?.supersedes, [first.directive.id]);
  });

  it("does not touch unrelated directives when superseding one of several", async () => {
    const a = await appendDirective("u@x", "fp1", {
      kind: "exclude",
      text: "omit Hair Oil",
      source: "chat-message",
    });
    const b = await appendDirective("u@x", "fp1", {
      kind: "exclude",
      text: "omit Pure Sense",
      source: "chat-message",
    });
    await appendDirective("u@x", "fp1", {
      kind: "include-only",
      text: "include Hair Oil again",
      source: "chat-message",
      supersedes: [a.directive.id],
    });
    const active = await listActiveDirectives("u@x", "fp1");
    const activeIds = active.map((d) => d.id);
    assert.ok(activeIds.includes(b.directive.id), "Pure Sense rule untouched");
    assert.ok(!activeIds.includes(a.directive.id), "Hair Oil rule superseded");
  });

  it("serialises concurrent appends through the per-fingerprint lock", async () => {
    // Fire many concurrent appends — without a lock, RMW races could lose
    // some entries. After all settle, the doc must contain ALL N entries.
    const N = 6;
    const drafts = Array.from({ length: N }, (_, i) => ({
      kind: "exclude" as const,
      text: `rule ${i}`,
      source: "chat-message" as const,
    }));
    await Promise.all(
      drafts.map((d) => appendDirective("u@x", "fp_concurrency", d))
    );
    const doc = await getDatasetDirectivesDoc("u@x", "fp_concurrency");
    assert.equal(doc.directives.length, N);
    assert.equal(doc.version, N);
  });

  it("preserves a HUGE text payload — no cap (user requirement)", async () => {
    const huge = "x".repeat(120_000);
    const { directive } = await appendDirective("u@x", "fp_big", {
      kind: "free-text",
      text: huge,
      source: "upload-context",
    });
    assert.equal(directive.text.length, 120_000);
  });
});

describe("W-UD2 · revokeDirective", () => {
  it("flips status to 'revoked' but keeps the audit entry", async () => {
    const { directive } = await appendDirective("u@x", "fp1", {
      kind: "exclude",
      text: "omit Hair Oil",
      source: "chat-message",
    });
    const updated = await revokeDirective("u@x", "fp1", directive.id);
    assert.ok(updated, "revoke should succeed");
    const entry = updated.directives.find((d) => d.id === directive.id);
    assert.equal(entry?.status, "revoked");
    const active = await listActiveDirectives("u@x", "fp1");
    assert.equal(active.length, 0, "revoked directive no longer active");
  });

  it("returns null when the directive id is unknown", async () => {
    const result = await revokeDirective("u@x", "fp1", "nope");
    assert.equal(result, null);
  });

  it("is idempotent on already-revoked directives", async () => {
    const { directive } = await appendDirective("u@x", "fp1", {
      kind: "exclude",
      text: "omit Hair Oil",
      source: "chat-message",
    });
    await revokeDirective("u@x", "fp1", directive.id);
    const second = await revokeDirective("u@x", "fp1", directive.id);
    assert.equal(second, null, "second revoke is a no-op");
  });
});

describe("W-UD2 · cross-dataset isolation", () => {
  it("directives on fingerprint A do NOT appear in fingerprint B", async () => {
    await appendDirective("u@x", "fpA", {
      kind: "exclude",
      text: "omit X",
      source: "chat-message",
    });
    const aActive = await listActiveDirectives("u@x", "fpA");
    const bActive = await listActiveDirectives("u@x", "fpB");
    assert.equal(aActive.length, 1);
    assert.equal(bActive.length, 0);
  });

  it("directives on user A do NOT leak to user B (per-user partition)", async () => {
    await appendDirective("alice@x", "fp1", {
      kind: "exclude",
      text: "omit Hair Oil",
      source: "chat-message",
    });
    const aliceActive = await listActiveDirectives("alice@x", "fp1");
    const bobActive = await listActiveDirectives("bob@x", "fp1");
    assert.equal(aliceActive.length, 1);
    assert.equal(bobActive.length, 0);
  });
});
