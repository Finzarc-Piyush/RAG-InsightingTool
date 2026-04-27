import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonFieldStreamExtractor } from "../lib/agents/runtime/jsonFieldStreamExtractor.js";

/**
 * Helper: feed an entire JSON string through the extractor in N random
 * chunk splits. Returns the concatenated emissions.
 */
function feedInChunks(json: string, fieldName: string, chunks: number): string {
  const e = new JsonFieldStreamExtractor(fieldName);
  let out = "";
  if (chunks <= 1) return e.process(json);
  // Random-ish but deterministic split points for reproducibility.
  const splitPoints: number[] = [];
  const step = Math.floor(json.length / chunks);
  for (let i = 1; i < chunks; i++) splitPoints.push(i * step);
  splitPoints.sort((a, b) => a - b);
  let prev = 0;
  for (const sp of splitPoints) {
    out += e.process(json.slice(prev, sp));
    prev = sp;
  }
  out += e.process(json.slice(prev));
  return out;
}

describe("W41 · JsonFieldStreamExtractor — single-chunk happy path", () => {
  it("extracts a plain body field from one full chunk", () => {
    const json = `{"body":"Saffola lost MT share in Q3.","tldr":"x"}`;
    const out = feedInChunks(json, "body", 1);
    assert.equal(out, "Saffola lost MT share in Q3.");
  });

  it("decodes \\\" escape into actual quote", () => {
    const json = `{"body":"He said \\"yes\\" to the proposal."}`;
    const out = feedInChunks(json, "body", 1);
    assert.equal(out, 'He said "yes" to the proposal.');
  });

  it("decodes \\n into actual newline", () => {
    const json = `{"body":"line1\\nline2"}`;
    const out = feedInChunks(json, "body", 1);
    assert.equal(out, "line1\nline2");
  });

  it("decodes \\\\ into single backslash", () => {
    const json = `{"body":"path\\\\to\\\\file"}`;
    const out = feedInChunks(json, "body", 1);
    assert.equal(out, "path\\to\\file");
  });

  it("does not emit content before the field opener", () => {
    const json = `{"id":42,"tldr":"head","body":"actual content"}`;
    const out = feedInChunks(json, "body", 1);
    assert.equal(out, "actual content");
  });
});

describe("W41 · chunk-boundary robustness", () => {
  const json = `{"body":"South-MT volume dropped 8% MoM. Pack-mix shifted 3 ppt toward 1L SKUs.","tldr":"head"}`;
  const expected = "South-MT volume dropped 8% MoM. Pack-mix shifted 3 ppt toward 1L SKUs.";

  for (const n of [2, 3, 5, 7, 11, 17]) {
    it(`accumulates correctly across ${n} chunks`, () => {
      const out = feedInChunks(json, "body", n);
      assert.equal(out, expected);
    });
  }

  it("handles a split mid-escape sequence (\\\")", () => {
    const e = new JsonFieldStreamExtractor("body");
    // Split right between `\` and `"` — the trailing-backslash safety
    // logic must hold the `\` back until the next chunk arrives.
    const part1 = `{"body":"He said \\`;
    const part2 = `"yes\\" again"}`;
    const out = e.process(part1) + e.process(part2);
    assert.equal(out, 'He said "yes" again');
  });

  it("handles a partial \\u escape across chunks (passes through raw)", () => {
    const e = new JsonFieldStreamExtractor("body");
    const part1 = `{"body":"alpha \\u00`;
    const part2 = `41 omega"}`;
    const out = e.process(part1) + e.process(part2);
    // \uXXXX passes through as raw 6 chars (per the W41 contract).
    assert.equal(out, "alpha \\u0041 omega");
  });
});

describe("W41 · termination behaviour", () => {
  it("emits empty string for chunks after the field's close quote", () => {
    const e = new JsonFieldStreamExtractor("body");
    const a = e.process(`{"body":"done","trailing":"x"}`);
    const b = e.process(`extra-stuff`);
    assert.equal(a, "done");
    assert.equal(b, "");
    assert.equal(e.isDone(), true);
  });

  it("isDone() is false until the close quote arrives", () => {
    const e = new JsonFieldStreamExtractor("body");
    e.process(`{"body":"streaming...`);
    assert.equal(e.isDone(), false);
    e.process(`done"}`);
    assert.equal(e.isDone(), true);
  });
});

describe("W41 · safety when malformed", () => {
  it("returns '' silently when the field never appears in the stream", () => {
    const e = new JsonFieldStreamExtractor("body");
    const out = e.process(`{"other":"value","still":"no body"}`);
    assert.equal(out, "");
    assert.equal(e.isDone(), false);
  });

  it("returns '' silently when the value is not a string", () => {
    const e = new JsonFieldStreamExtractor("body");
    e.process(`{"body":42,"x":"y"}`);
    // body's value is a number — extractor marks done without emitting.
    assert.equal(e.isDone(), true);
  });

  it("never throws on a never-closes string (truncated stream)", () => {
    const e = new JsonFieldStreamExtractor("body");
    assert.doesNotThrow(() => {
      e.process(`{"body":"streaming forever and never closing\\\\nwith content`);
    });
    // Some text was emitted — best-effort.
    assert.equal(e.isDone(), false);
  });

  it("never throws on a trailing lone backslash", () => {
    const e = new JsonFieldStreamExtractor("body");
    assert.doesNotThrow(() => {
      const out = e.process(`{"body":"trailing slash \\`);
      // The lone backslash is held back; nothing after it yet.
      assert.equal(out, "trailing slash ");
    });
  });
});
