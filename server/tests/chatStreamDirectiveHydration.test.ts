// Wave W-UD-integration · pins the chatStream kickoff helper's directive
// hydration contract: when `hydrateDirectives` is supplied, the returned
// kickoff result carries an `activeDirectives` Promise that resolves to
// the hydrator's result in parallel with the other three thunks. When the
// hydrator throws, the promise resolves to `[]` so callers can always
// pass the result into `buildAgentExecutionContext` without a null check.
//
// Tested in isolation (against the pure kickoff helper) rather than the
// 4 KLOC `processStreamChat` host so the contract is pinned without
// pulling in SSE plumbing or Cosmos mocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { kickOffPreClassifyWork } from "../services/chat/chatStreamPreClassifyKickoff.js";
import type { UserDirective } from "../shared/schema.js";

function defer<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeDirective(id: string, kind: UserDirective["kind"] = "exclude"): UserDirective {
  return {
    id,
    scope: "dataset",
    kind,
    text: `directive ${id}`,
    source: "chat-message",
    addedAt: 1,
    status: "active",
  };
}

test("hydrateDirectives fires concurrently with the other kickoff thunks", async () => {
  const startOrder: string[] = [];
  const schemaDef = defer<{ canonicalColumns: string[] }>();
  const parseDef = defer<{ groupBy: string[] }>();
  const domainDef = defer<{ text: string }>();
  const directiveDef = defer<UserDirective[]>();

  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: () => {
      startOrder.push("schemaBind");
      return schemaDef.promise;
    },
    parseUserQuery: () => {
      startOrder.push("parseUserQuery");
      return parseDef.promise;
    },
    loadDomainContext: () => {
      startOrder.push("domainContext");
      return domainDef.promise;
    },
    hydrateDirectives: () => {
      startOrder.push("hydrateDirectives");
      return directiveDef.promise;
    },
  });

  // All four start calls fired synchronously inside the helper.
  assert.deepEqual(startOrder, [
    "schemaBind",
    "parseUserQuery",
    "domainContext",
    "hydrateDirectives",
  ]);

  const directives = [fakeDirective("d1"), fakeDirective("d2", "include-only")];
  directiveDef.resolve(directives);
  schemaDef.resolve({ canonicalColumns: ["sales"] });
  parseDef.resolve({ groupBy: ["region"] });
  domainDef.resolve({ text: "" });

  const resolved = await kickoff.activeDirectives;
  assert.deepEqual(resolved, directives);
});

test("activeDirectives resolves to [] when no hydrator is supplied", async () => {
  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => ({ canonicalColumns: [] }),
    parseUserQuery: async () => ({ groupBy: [] }),
    loadDomainContext: async () => ({ text: "" }),
  });
  const resolved = await kickoff.activeDirectives;
  assert.deepEqual(resolved, []);
});

test("hydrateDirectives rejection collapses to [] (never throws)", async () => {
  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => ({ canonicalColumns: [] }),
    parseUserQuery: async () => ({ groupBy: [] }),
    loadDomainContext: async () => ({ text: "" }),
    hydrateDirectives: async () => {
      throw new Error("cosmos read failed");
    },
  });
  const resolved = await kickoff.activeDirectives;
  assert.deepEqual(resolved, []);

  // Sibling promises still settle normally.
  await assert.doesNotReject(kickoff.schemaBinding);
  await assert.doesNotReject(kickoff.parsedQuery);
  await assert.doesNotReject(kickoff.domainContext);
});

test("hydrator is invoked exactly once per kickoff call", async () => {
  let calls = 0;
  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => ({ canonicalColumns: [] }),
    parseUserQuery: async () => ({ groupBy: [] }),
    loadDomainContext: async () => ({ text: "" }),
    hydrateDirectives: async () => {
      calls += 1;
      return [fakeDirective("only-call")];
    },
  });

  // Awaiting the same promise repeatedly must reuse the original
  // resolution, not re-invoke the hydrator.
  await kickoff.activeDirectives;
  await kickoff.activeDirectives;
  await kickoff.activeDirectives;
  assert.equal(calls, 1);
});

test("hydrateDirectives runs in parallel with schemaBinding (overlap pin)", async () => {
  // Resolve order: directive hydrator settles BEFORE the schema thunk.
  // If the helper accidentally awaited schemaBinding before kicking off
  // the directive hydrator (or wrapped it in a `.then()` chain), this
  // ordering would be impossible — the test would deadlock waiting on
  // the directive promise.
  const schemaDef = defer<{ canonicalColumns: string[] }>();
  const directiveValue = [fakeDirective("parallel")];

  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: () => schemaDef.promise,
    parseUserQuery: async () => ({ groupBy: [] }),
    loadDomainContext: async () => ({ text: "" }),
    hydrateDirectives: async () => directiveValue,
  });

  const directives = await kickoff.activeDirectives;
  assert.equal(directives, directiveValue);

  // Now release the schema thunk and confirm it still resolves cleanly.
  schemaDef.resolve({ canonicalColumns: ["x"] });
  const schema = await kickoff.schemaBinding;
  assert.deepEqual(schema, { canonicalColumns: ["x"] });
});
