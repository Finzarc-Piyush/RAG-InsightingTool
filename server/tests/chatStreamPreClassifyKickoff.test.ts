// Wave WS2-pre-classify-parallel · unit tests for the pure kickoff helper
// that fires schemaBind + parseUserQuery + domainContext concurrently so
// the chatStream.service.ts critical path can `await` each at its existing
// consumption site while the others overlap.
//
// The helper is tested in isolation (rather than through the 2,398-LOC
// processStreamChat host) so the contract — concurrent kickoff,
// catch-and-null on parseUserQuery / domainContext, propagate on
// schemaBind, no value-shape mutation — is pinned without dragging in
// SSE plumbing or DB mocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { kickOffPreClassifyWork } from "../services/chat/chatStreamPreClassifyKickoff.js";

// A deferred promise utility so each test can choreograph resolution order
// between the three concurrent operations and observe overlap directly.
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

test("kicks off all three operations concurrently before any awaited resolution", async () => {
  const startOrder: string[] = [];

  const schemaDef = defer<{ canonicalColumns: string[] }>();
  const parseDef = defer<{ groupBy: string[] }>();
  const domainDef = defer<{ text: string }>();

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
  });

  // All three start calls fired synchronously inside the helper, before
  // any awaiting in the caller resolved.
  assert.deepEqual(startOrder, ["schemaBind", "parseUserQuery", "domainContext"]);

  // Resolve in reverse order to prove independence: the schemaBind await
  // does not gate the parseUserQuery / domainContext kickoffs.
  domainDef.resolve({ text: "domain text" });
  parseDef.resolve({ groupBy: ["region"] });
  schemaDef.resolve({ canonicalColumns: ["sales"] });

  const [schema, parsed, domain] = await Promise.all([
    kickoff.schemaBinding,
    kickoff.parsedQuery,
    kickoff.domainContext,
  ]);

  assert.deepEqual(schema, { canonicalColumns: ["sales"] });
  assert.deepEqual(parsed, { groupBy: ["region"] });
  assert.deepEqual(domain, { text: "domain text" });
});

test("parseUserQuery rejection resolves the kickoff promise to null", async () => {
  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => ({ canonicalColumns: [] }),
    parseUserQuery: async () => {
      throw new Error("parser blew up");
    },
    loadDomainContext: async () => ({ text: "" }),
  });

  const parsed = await kickoff.parsedQuery;
  assert.equal(parsed, null);

  // Sibling promises still settle normally.
  await assert.doesNotReject(kickoff.schemaBinding);
  await assert.doesNotReject(kickoff.domainContext);
});

test("loadDomainContext rejection resolves the kickoff promise to null", async () => {
  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => ({ canonicalColumns: [] }),
    parseUserQuery: async () => ({ groupBy: [] }),
    loadDomainContext: async () => {
      throw new Error("disk fault");
    },
  });

  const domain = await kickoff.domainContext;
  assert.equal(domain, null);

  await assert.doesNotReject(kickoff.schemaBinding);
  await assert.doesNotReject(kickoff.parsedQuery);
});

test("bindSchemaColumns rejection propagates on await", async () => {
  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => {
      throw new Error("schema binder failed");
    },
    parseUserQuery: async () => ({ groupBy: [] }),
    loadDomainContext: async () => ({ text: "" }),
  });

  await assert.rejects(kickoff.schemaBinding, /schema binder failed/);

  // Siblings still resolve cleanly — no cross-cancellation.
  const parsed = await kickoff.parsedQuery;
  const domain = await kickoff.domainContext;
  assert.deepEqual(parsed, { groupBy: [] });
  assert.deepEqual(domain, { text: "" });
});

test("simultaneous schemaBind throw and parseUserQuery throw leave no unhandled rejection", async () => {
  // Race condition pin: if both reject in the same microtask, the
  // .catch(() => null) on parseUserQuery must absorb its rejection BEFORE
  // the caller's `await kickoff.schemaBinding` runs, so no warning fires.
  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => {
      throw new Error("schema fail");
    },
    parseUserQuery: async () => {
      throw new Error("parse fail");
    },
    loadDomainContext: async () => {
      throw new Error("domain fail");
    },
  });

  // Drain the propagating side first.
  await assert.rejects(kickoff.schemaBinding, /schema fail/);

  // Confirm the catching kickoffs absorbed their errors to null.
  assert.equal(await kickoff.parsedQuery, null);
  assert.equal(await kickoff.domainContext, null);
});

test("happy-path values pass through unchanged (no shape mutation)", async () => {
  const schemaShape = {
    canonicalColumns: ["sales", "region"],
    columnMapping: { sales: "Sales", region: "Region" },
    nested: { deeply: { kept: true } },
  };
  const parseShape = {
    groupBy: ["region"],
    filters: [{ column: "region", op: "=", value: "North" }],
    confidence: 0.87,
  };
  const domainShape = {
    text: "Marico domain glossary…",
    packs: [{ name: "haircare" }],
    totalEnabledTokens: 4321,
  };

  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => schemaShape,
    parseUserQuery: async () => parseShape,
    loadDomainContext: async () => domainShape,
  });

  // Reference equality — kickoff does NOT copy or transform values.
  assert.strictEqual(await kickoff.schemaBinding, schemaShape);
  assert.strictEqual(await kickoff.parsedQuery, parseShape);
  assert.strictEqual(await kickoff.domainContext, domainShape);
});

test("each thunk is invoked exactly once per kickoff call", async () => {
  let schemaCalls = 0;
  let parseCalls = 0;
  let domainCalls = 0;

  const kickoff = kickOffPreClassifyWork({
    bindSchemaColumns: async () => {
      schemaCalls += 1;
      return { canonicalColumns: [] };
    },
    parseUserQuery: async () => {
      parseCalls += 1;
      return { groupBy: [] };
    },
    loadDomainContext: async () => {
      domainCalls += 1;
      return { text: "" };
    },
  });

  // Awaiting the same kickoff promise multiple times re-uses the original
  // resolved value — the thunk must NOT be re-invoked on each await.
  await kickoff.schemaBinding;
  await kickoff.schemaBinding;
  await kickoff.parsedQuery;
  await kickoff.parsedQuery;
  await kickoff.domainContext;
  await kickoff.domainContext;

  assert.equal(schemaCalls, 1);
  assert.equal(parseCalls, 1);
  assert.equal(domainCalls, 1);
});
