import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeInMemoryContainer, type StoredDoc } from "./inMemoryCosmosContainer.js";

/**
 * SEMANTICS SELF-TEST · the trust anchor for the in-memory Cosmos `Container`
 * double. Because the double gates refactors of the core write path, its
 * fidelity to documented `@azure/cosmos` semantics must be proven here, not
 * assumed. Every assertion below maps to a behaviour the app relies on.
 */

type Code = { code?: number };

describe("inMemoryCosmosContainer · SDK semantics", () => {
  it("items.create → assigns id/_etag/_ts; point-read round-trips", async () => {
    const { container } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    const { resource } = await container.items.create({ username: "a@x.com", note: "hi" } as StoredDoc);
    assert.ok(resource, "create returns a resource"); // 1
    assert.ok(resource.id, "create assigns an id when absent"); // 2
    assert.ok(typeof resource._etag === "string" && resource._etag.length > 0, "create assigns an _etag"); // 3
    assert.ok(typeof resource._ts === "number", "create assigns a _ts"); // 4

    const back = await container.item(resource.id!, "a@x.com").read();
    assert.equal(back.resource?.note, "hi", "read returns the stored doc"); // 5
    assert.equal(back.resource?._etag, resource._etag, "read returns the same _etag"); // 6
  });

  it("items.create → 409 on duplicate (pk,id)", async () => {
    const { container } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    await container.items.create({ id: "dup", username: "a@x.com" } as StoredDoc);
    await assert.rejects(
      () => container.items.create({ id: "dup", username: "a@x.com" } as StoredDoc),
      (e: Code) => e.code === 409, // 7
      "duplicate (pk,id) → 409",
    );
    // Same id but DIFFERENT partition is allowed (distinct logical key).
    const ok = await container.items.create({ id: "dup", username: "b@x.com" } as StoredDoc);
    assert.ok(ok.resource, "same id in a different partition is allowed"); // 8
  });

  it("items.upsert → create-or-replace, bumps _etag", async () => {
    const { container } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    const first = await container.items.upsert({ id: "u1", username: "a@x.com", v: 1 } as StoredDoc);
    const etag1 = first.resource._etag;
    const second = await container.items.upsert({ id: "u1", username: "a@x.com", v: 2 } as StoredDoc);
    assert.equal(second.resource.v, 2, "upsert replaces the stored doc"); // 9
    assert.notEqual(second.resource._etag, etag1, "upsert bumps the _etag"); // 10
  });

  it("point-read with WRONG partition key → miss (resource undefined)", async () => {
    const { container } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    await container.items.create({ id: "p1", username: "owner@x.com" } as StoredDoc);
    const miss = await container.item("p1", "someoneelse@x.com").read();
    assert.equal(miss.resource, undefined, "wrong pk → not found, resource undefined (SDK swallows 404)"); // 11
    const hit = await container.item("p1", "owner@x.com").read();
    assert.ok(hit.resource, "correct pk → found"); // 12
  });

  it("replace IfMatch → stale etag 412, current etag succeeds + etag changes", async () => {
    const { container } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    const created = await container.items.create({ id: "r1", username: "a@x.com", v: 1 } as StoredDoc);
    const currentEtag = created.resource._etag!;

    await assert.rejects(
      () =>
        container.item("r1", "a@x.com").replace(
          { id: "r1", username: "a@x.com", v: 2 } as StoredDoc,
          { accessCondition: { type: "IfMatch", condition: "stale-etag-value" } },
        ),
      (e: Code) => e.code === 412, // 13
      "stale IfMatch etag → 412",
    );

    const replaced = await container.item("r1", "a@x.com").replace(
      { id: "r1", username: "a@x.com", v: 2 } as StoredDoc,
      { accessCondition: { type: "IfMatch", condition: currentEtag } },
    );
    assert.equal(replaced.resource.v, 2, "current IfMatch etag → replace succeeds"); // 14
    assert.notEqual(replaced.resource._etag, currentEtag, "successful replace changes the _etag"); // 15
  });

  it("upsert IfMatch (the updateChatDocument conditional write) → 412 vs success", async () => {
    const { container } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    const created = await container.items.create({ id: "c1", username: "a@x.com", v: 1 } as StoredDoc);
    const etag = created.resource._etag!;
    await assert.rejects(
      () =>
        container.items.upsert({ id: "c1", username: "a@x.com", v: 9 } as StoredDoc, {
          accessCondition: { type: "IfMatch", condition: "wrong" },
        }),
      (e: Code) => e.code === 412, // 16
      "upsert with stale IfMatch → 412",
    );
    const ok = await container.items.upsert({ id: "c1", username: "a@x.com", v: 9 } as StoredDoc, {
      accessCondition: { type: "IfMatch", condition: etag },
    });
    assert.equal(ok.resource.v, 9, "upsert with current IfMatch → success"); // 17
  });

  it("delete → removes; 404 on absent", async () => {
    const { container, size } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    await container.items.create({ id: "d1", username: "a@x.com" } as StoredDoc);
    await container.item("d1", "a@x.com").delete();
    assert.equal(size(), 0, "delete removes the doc"); // 18
    await assert.rejects(
      () => container.item("d1", "a@x.com").delete(),
      (e: Code) => e.code === 404, // 19
      "delete on absent → 404",
    );
  });

  it("patch → set/incr/remove; 404 on absent", async () => {
    const { container } = makeInMemoryContainer([], { partitionKeyPath: "/username" });
    await container.items.create({ id: "pa", username: "a@x.com", n: 5, drop: "x" } as StoredDoc);
    const patched = await container.item("pa", "a@x.com").patch({
      operations: [
        { op: "incr", path: "/n", value: 3 },
        { op: "set", path: "/label", value: "done" },
        { op: "remove", path: "/drop" },
      ],
    });
    assert.equal(patched.resource?.n, 8, "incr adds to the numeric field"); // 20
    assert.equal(patched.resource?.label, "done", "set writes a new field"); // 21
    assert.equal(patched.resource?.drop, undefined, "remove drops the field"); // 22
    await assert.rejects(
      () => container.item("absent", "a@x.com").patch({ operations: [{ op: "set", path: "/x", value: 1 }] }),
      (e: Code) => e.code === 404, // 23
      "patch on absent → 404",
    );
  });

  // --- query evaluator -------------------------------------------------------

  const querySeed: StoredDoc[] = [
    { id: "1", username: "u1", region: "North", sales: 100, tags: ["a", "b"], createdAt: 30 },
    { id: "2", username: "u1", region: "South", sales: 200, tags: ["b", "c"], createdAt: 10 },
    { id: "3", username: "u2", region: "North", sales: 50, tags: ["a"], createdAt: 20 },
    { id: "4", username: "u2", region: "West", sales: 300, createdAt: 40 }, // no tags field
  ];

  it("query equality with @param", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const { resources } = await container.items
      .query({ query: "SELECT * FROM c WHERE c.region = @r", parameters: [{ name: "@r", value: "North" }] })
      .fetchAll();
    assert.equal(resources.length, 2, "equality matches 2 North rows"); // 24
  });

  it("query AND / OR / relational", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const andRes = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.region = @r AND c.sales > @min",
        parameters: [{ name: "@r", value: "North" }, { name: "@min", value: 60 }],
      })
      .fetchAll();
    assert.deepEqual(
      andRes.resources.map((r) => r.id),
      ["1"],
      "AND + relational: North & sales>60 → only row 1",
    ); // 25

    const orRes = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.region = @a OR c.region = @b",
        parameters: [{ name: "@a", value: "South" }, { name: "@b", value: "West" }],
      })
      .fetchAll();
    assert.equal(orRes.resources.length, 2, "OR matches South + West"); // 26
  });

  it("query ARRAY_CONTAINS(c.arr, @p) — missing field never matches", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.tags, @t)",
        parameters: [{ name: "@t", value: "a" }],
      })
      .fetchAll();
    assert.deepEqual(resources.map((r) => r.id).sort(), ["1", "3"], "ARRAY_CONTAINS matches rows with tag 'a'"); // 27
    // Row 4 has no `tags` field → never matches (faithful undefined semantics).
    assert.ok(!resources.some((r) => r.id === "4"), "missing array field never matches"); // 28
  });

  it("query ARRAY_CONTAINS(@types, c.field) — param-is-array form", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE ARRAY_CONTAINS(@regions, c.region)",
        parameters: [{ name: "@regions", value: ["South", "West"] }],
      })
      .fetchAll();
    assert.equal(resources.length, 2, "param-array ARRAY_CONTAINS matches South + West"); // 29
  });

  it("query ORDER BY ASC and DESC", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const asc = await container.items.query("SELECT * FROM c ORDER BY c.createdAt ASC").fetchAll();
    assert.deepEqual(asc.resources.map((r) => r.createdAt), [10, 20, 30, 40], "ORDER BY ASC sorts ascending"); // 30
    const desc = await container.items.query("SELECT * FROM c ORDER BY c.createdAt DESC").fetchAll();
    assert.deepEqual(desc.resources.map((r) => r.createdAt), [40, 30, 20, 10], "ORDER BY DESC sorts descending"); // 31
    // ASC is the default when no direction is given.
    const def = await container.items.query("SELECT * FROM c ORDER BY c.createdAt").fetchAll();
    assert.deepEqual(def.resources.map((r) => r.createdAt), [10, 20, 30, 40], "ORDER BY defaults to ASC"); // 32
  });

  it("query OFFSET/LIMIT (literal + @param)", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const page = await container.items
      .query("SELECT * FROM c ORDER BY c.createdAt ASC OFFSET 1 LIMIT 2")
      .fetchAll();
    assert.deepEqual(page.resources.map((r) => r.createdAt), [20, 30], "OFFSET 1 LIMIT 2 windows the result"); // 33
    const paramPage = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.username = @u ORDER BY c.createdAt DESC OFFSET 0 LIMIT @lim",
        parameters: [{ name: "@u", value: "u1" }, { name: "@lim", value: 1 }],
      })
      .fetchAll();
    assert.deepEqual(paramPage.resources.map((r) => r.id), ["1"], "@param LIMIT binds correctly"); // 34
  });

  it("query TOP <n>", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const { resources } = await container.items
      .query("SELECT TOP 2 * FROM c ORDER BY c.sales DESC")
      .fetchAll();
    assert.deepEqual(resources.map((r) => r.id), ["4", "2"], "TOP 2 by sales DESC → 300,200"); // 35
  });

  it("query VALUE COUNT(1)", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const { resources } = await container.items
      .query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.region = @r", parameters: [{ name: "@r", value: "North" }] })
      .fetchAll();
    assert.deepEqual(resources, [2], "VALUE COUNT(1) returns the count as the single resource"); // 36
  });

  it("query field projection", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const { resources } = await container.items
      .query("SELECT c.id, c.region FROM c WHERE c.id = '1'")
      .fetchAll();
    assert.deepEqual(resources, [{ id: "1", region: "North" }], "projection returns only the selected fields"); // 37
  });

  it("cross-partition scan (no pk option) vs partition-scoped", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    // No partitionKey option → scans ALL partitions.
    const all = await container.items.query("SELECT * FROM c").fetchAll();
    assert.equal(all.resources.length, 4, "no-pk query is a cross-partition scan over all docs"); // 38
    // partitionKey option → only that partition's docs are candidates.
    const scoped = await container.items
      .query("SELECT * FROM c", { partitionKey: "u1" })
      .fetchAll();
    assert.equal(scoped.resources.length, 2, "pk-scoped query only sees that partition"); // 39
  });

  it("fetchNext returns a single page then hasMoreResults=false", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const it = container.items.query("SELECT * FROM c");
    const p1 = await it.fetchNext();
    assert.equal(p1.resources.length, 4, "fetchNext returns all rows in one page"); // 40
    assert.equal(p1.hasMoreResults, false, "no more pages after the first"); // 41
    const p2 = await it.fetchNext();
    assert.deepEqual(p2.resources, [], "second fetchNext is empty"); // 42
  });

  it("unsupported query shape throws loud", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    assert.throws(
      () => container.items.query("SELECT * FROM c GROUP BY c.region").fetchAll(),
      /unsupported query/i, // 43
      "an unsupported shape fails loud rather than silently wrong",
    );
  });

  it("missing-field equality never matches (faithful undefined semantics)", async () => {
    const { container } = makeInMemoryContainer(querySeed, { partitionKeyPath: "/username" });
    const { resources } = await container.items
      .query({ query: "SELECT * FROM c WHERE c.missingField = @v", parameters: [{ name: "@v", value: "anything" }] })
      .fetchAll();
    assert.equal(resources.length, 0, "c.x = @p returns no rows when x is absent"); // 44
  });
});
