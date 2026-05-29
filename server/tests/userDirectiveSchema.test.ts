// Wave W-UD1 · UserDirective + DatasetDirectivesDoc Zod schema tests
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  userDirectiveSchema,
  datasetDirectivesDocSchema,
  type UserDirective,
} from "../shared/schema.js";

const validBase: UserDirective = {
  id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
  scope: "dataset",
  kind: "exclude",
  text: "from now on omit Hair Oil from any category breakdown",
  source: "chat-message",
  sourceSessionId: "sess-123",
  sourceTurnId: "msg-456",
  addedAt: Date.now(),
  status: "active",
};

describe("userDirectiveSchema", () => {
  it("accepts a minimum valid directive", () => {
    const parsed = userDirectiveSchema.parse(validBase);
    assert.equal(parsed.kind, "exclude");
    assert.equal(parsed.status, "active");
  });

  it("accepts every legal scope value (including reserved Phase B scopes)", () => {
    for (const scope of ["session", "dataset", "user", "tenant"] as const) {
      assert.doesNotThrow(() =>
        userDirectiveSchema.parse({ ...validBase, scope })
      );
    }
  });

  it("accepts every legal kind value", () => {
    for (const kind of [
      "exclude",
      "include-only",
      "rename",
      "preference",
      "definition",
      "free-text",
    ] as const) {
      assert.doesNotThrow(() =>
        userDirectiveSchema.parse({ ...validBase, kind })
      );
    }
  });

  it("rejects unknown scope / kind / status / source values", () => {
    assert.throws(() =>
      userDirectiveSchema.parse({ ...validBase, scope: "global" as any })
    );
    assert.throws(() =>
      userDirectiveSchema.parse({ ...validBase, kind: "delete" as any })
    );
    assert.throws(() =>
      userDirectiveSchema.parse({ ...validBase, status: "draft" as any })
    );
    assert.throws(() =>
      userDirectiveSchema.parse({ ...validBase, source: "import" as any })
    );
  });

  it("accepts a HUGE text payload — no length cap (user requirement)", () => {
    const huge = "x".repeat(250_000);
    const parsed = userDirectiveSchema.parse({ ...validBase, text: huge });
    assert.equal(parsed.text.length, 250_000);
  });

  it("rejects empty text — at least one char required", () => {
    assert.throws(() => userDirectiveSchema.parse({ ...validBase, text: "" }));
  });

  it("accepts structured projection with column / op / values", () => {
    const parsed = userDirectiveSchema.parse({
      ...validBase,
      structured: {
        column: "category",
        op: "not_in",
        values: ["Hair Oil"],
      },
    });
    assert.equal(parsed.structured?.op, "not_in");
  });

  it("accepts supersedes + supersededBy id linkage", () => {
    const parsed = userDirectiveSchema.parse({
      ...validBase,
      supersedes: ["old-id-1", "old-id-2"],
    });
    assert.deepEqual(parsed.supersedes, ["old-id-1", "old-id-2"]);

    const parsed2 = userDirectiveSchema.parse({
      ...validBase,
      status: "superseded",
      supersededBy: "newer-id",
    });
    assert.equal(parsed2.supersededBy, "newer-id");
  });
});

describe("datasetDirectivesDocSchema", () => {
  it("accepts a populated doc with multiple directives", () => {
    const doc = {
      id: "user@example.com__abc123def4567890",
      username: "user@example.com",
      datasetFingerprint: "abc123def4567890",
      directives: [
        validBase,
        { ...validBase, id: "02HXXXX", status: "superseded" as const },
      ],
      version: 5,
      updatedAt: Date.now(),
    };
    const parsed = datasetDirectivesDocSchema.parse(doc);
    assert.equal(parsed.directives.length, 2);
    assert.equal(parsed.version, 5);
  });

  it("accepts an empty directives array (newly initialised doc)", () => {
    assert.doesNotThrow(() =>
      datasetDirectivesDocSchema.parse({
        id: "user@example.com__deadbeefcafef00d",
        username: "user@example.com",
        datasetFingerprint: "deadbeefcafef00d",
        directives: [],
        version: 0,
        updatedAt: Date.now(),
      })
    );
  });

  it("rejects negative version or updatedAt", () => {
    assert.throws(() =>
      datasetDirectivesDocSchema.parse({
        id: "x",
        username: "u",
        datasetFingerprint: "fp",
        directives: [],
        version: -1,
        updatedAt: Date.now(),
      })
    );
  });
});
