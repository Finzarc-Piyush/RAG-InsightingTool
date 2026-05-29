// Wave W-UD4 · deterministic user-directive extractor tests
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractUserDirectives,
  __PERSISTENCE_QUALIFIER_RE,
  __INCLUSION_VERB_RE,
  __detectSupersedeIdsForTesting,
} from "../lib/agents/runtime/extractUserDirectives.js";
import type { DataSummary, UserDirective } from "../shared/schema.js";

const brandSummary: DataSummary = {
  rowCount: 100,
  columnCount: 2,
  columns: [
    {
      name: "Brand",
      type: "string",
      sampleValues: ["Hair Oil", "Pure Sense", "Set Wet"],
      topValues: [
        { value: "Hair Oil", count: 40 },
        { value: "Pure Sense", count: 30 },
        { value: "Set Wet", count: 30 },
      ],
    },
    {
      name: "Sales",
      type: "number",
      sampleValues: [100, 200, 300],
    },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
};

describe("W-UD4 · persistence qualifier vocabulary", () => {
  it("matches the canonical phrasings", () => {
    const matches = [
      "always",
      "from now on",
      "going forward",
      "for the rest of this session",
      "for the rest of the chat",
      "for this dataset",
      "for all future questions",
      "for all future charts",
      "permanently",
      "by default",
      "every time",
      "whenever",
      "in general",
      "throughout",
      "hereafter",
    ];
    for (const phrase of matches) {
      assert.ok(
        __PERSISTENCE_QUALIFIER_RE.test(`from ${phrase} treat X as Y`),
        `should match "${phrase}"`
      );
    }
  });

  it("does NOT match casual one-shot phrasings", () => {
    assert.ok(!__PERSISTENCE_QUALIFIER_RE.test("just for now"));
    assert.ok(!__PERSISTENCE_QUALIFIER_RE.test("this once"));
    assert.ok(!__PERSISTENCE_QUALIFIER_RE.test("show me"));
  });
});

describe("W-UD4 · inclusion verb vocabulary", () => {
  it("matches the canonical inclusion phrasings", () => {
    for (const phrase of [
      "only show Hair Oil",
      "only include Pure Sense",
      "only use Brand A",
      "just show Brand B",
      "restrict to Hair Oil",
      "limit to Pure Sense",
      "stick to Brand A",
      "focus only on Hair Oil",
      "focus on Brand B",
    ]) {
      assert.ok(__INCLUSION_VERB_RE.test(phrase), `should match "${phrase}"`);
    }
  });
});

describe("W-UD4 · extractUserDirectives — no persistence qualifier", () => {
  it("returns empty when message is empty", () => {
    const out = extractUserDirectives({
      message: "",
      summary: brandSummary,
    });
    assert.deepEqual(out, []);
  });

  it("returns empty for a one-shot exclusion without a persistence qualifier", () => {
    // Plain "omit X for this question" — the existing one-turn
    // `inferFiltersFromQuestion` path handles this; we do NOT create a
    // persistent directive.
    const out = extractUserDirectives({
      message: "show brand sales but omit Hair Oil",
      summary: brandSummary,
    });
    assert.deepEqual(out, [], "no qualifier → no directive");
  });
});

describe("W-UD4 · extractUserDirectives — exclusion + qualifier", () => {
  it("emits an exclude directive for 'from now on omit X'", () => {
    const out = extractUserDirectives({
      message: "From now on omit Hair Oil from any brand breakdown.",
      summary: brandSummary,
      sourceSessionId: "sess-1",
      sourceTurnId: "msg-3",
    });
    assert.equal(out.length, 1);
    const { draft } = out[0]!;
    assert.equal(draft.kind, "exclude");
    assert.equal(draft.structured?.column, "Brand");
    assert.equal(draft.structured?.op, "not_in");
    assert.deepEqual(draft.structured?.values, ["Hair Oil"]);
    assert.equal(draft.source, "chat-message");
    assert.equal(draft.sourceSessionId, "sess-1");
    assert.equal(draft.scope, "dataset", "default scope is dataset");
  });

  it("emits an exclude directive for 'always exclude X'", () => {
    const out = extractUserDirectives({
      message: "Always exclude Pure Sense from totals.",
      summary: brandSummary,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.draft.kind, "exclude");
    assert.deepEqual(out[0]?.draft.structured?.values, ["Pure Sense"]);
  });

  it("emits an exclude directive for 'by default drop X'", () => {
    const out = extractUserDirectives({
      message: "By default drop Hair Oil from all brand charts.",
      summary: brandSummary,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.draft.structured?.op, "not_in");
  });

  it("does NOT emit when the captured clause is polarity-flipped", () => {
    // "except for X" inverts the exclusion intent: the clause names what to
    // KEEP. Mirrors the existing RD3 behaviour in inferFiltersFromQuestion.
    const out = extractUserDirectives({
      message: "From now on exclude everything except for Hair Oil.",
      summary: brandSummary,
    });
    assert.equal(out.length, 0);
  });
});

describe("W-UD4 · auto-supersede detection", () => {
  const olderExclude: UserDirective = {
    id: "old-1",
    scope: "dataset",
    kind: "exclude",
    text: "from now on omit Hair Oil",
    structured: { column: "Brand", op: "not_in", values: ["Hair Oil"] },
    source: "chat-message",
    addedAt: 1,
    status: "active",
  };

  it("returns the prior id when the new directive reverses its op", () => {
    const supersedes = __detectSupersedeIdsForTesting(
      {
        scope: "dataset",
        kind: "include-only",
        text: "actually include Hair Oil from now on",
        structured: { column: "Brand", op: "in", values: ["Hair Oil"] },
        source: "chat-message",
      },
      [olderExclude]
    );
    assert.deepEqual(supersedes, ["old-1"]);
  });

  it("does NOT supersede when columns differ", () => {
    const supersedes = __detectSupersedeIdsForTesting(
      {
        scope: "dataset",
        kind: "include-only",
        text: "include Pure Sense in Category",
        structured: { column: "Category", op: "in", values: ["Pure Sense"] },
        source: "chat-message",
      },
      [olderExclude]
    );
    assert.deepEqual(supersedes, []);
  });

  it("does NOT supersede when ops are the same and values differ", () => {
    // Two coexisting exclusion rules on different values are NOT in conflict.
    const supersedes = __detectSupersedeIdsForTesting(
      {
        scope: "dataset",
        kind: "exclude",
        text: "also exclude Pure Sense",
        structured: { column: "Brand", op: "not_in", values: ["Pure Sense"] },
        source: "chat-message",
      },
      [olderExclude]
    );
    assert.deepEqual(supersedes, []);
  });

  it("DOES supersede when the new directive is a tautological repeat", () => {
    const supersedes = __detectSupersedeIdsForTesting(
      {
        scope: "dataset",
        kind: "exclude",
        text: "omit Hair Oil",
        structured: { column: "Brand", op: "not_in", values: ["Hair Oil"] },
        source: "chat-message",
      },
      [olderExclude]
    );
    assert.deepEqual(supersedes, ["old-1"]);
  });

  it("does NOT supersede a non-active prior", () => {
    const inactive: UserDirective = { ...olderExclude, status: "revoked" };
    const supersedes = __detectSupersedeIdsForTesting(
      {
        scope: "dataset",
        kind: "include-only",
        text: "include Hair Oil",
        structured: { column: "Brand", op: "in", values: ["Hair Oil"] },
        source: "chat-message",
      },
      [inactive]
    );
    assert.deepEqual(supersedes, [], "revoked directives are out of supersede scope");
  });

  it("populates `supersedes` on the emitted draft when extraction conflicts", () => {
    // "only show X" matches INCLUSION_VERB_RE; "from now on" is the qualifier.
    // The structural overlap (Brand=Hair Oil, opposing op) triggers supersede.
    const out = extractUserDirectives({
      message: "From now on only show Hair Oil in brand breakdowns.",
      summary: brandSummary,
      existingDirectives: [olderExclude],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.draft.kind, "include-only");
    assert.deepEqual(out[0]?.draft.supersedes, ["old-1"]);
  });
});
