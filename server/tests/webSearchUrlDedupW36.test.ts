import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { extractUrlsFromFormattedHits } = await import(
  "../lib/agents/runtime/tools/webSearchTool.js"
);

describe("W36 · extractUrlsFromFormattedHits (URL extraction from formatted hit blocks)", () => {
  it("returns [] for empty / whitespace input", () => {
    assert.deepEqual(extractUrlsFromFormattedHits(""), []);
    assert.deepEqual(extractUrlsFromFormattedHits("   \n\n"), []);
  });

  it("extracts a single URL from a single-hit block", () => {
    const formatted = `[web:tavily:1] Hair-oil category Q3 growth\nIndian hair-oil market grew ~4% YoY in Q3 per industry trackers.\n— https://example.com/report-q3`;
    assert.deepEqual(
      extractUrlsFromFormattedHits(formatted),
      ["https://example.com/report-q3"]
    );
  });

  it("extracts multiple URLs from a multi-hit block", () => {
    const formatted = [
      `[web:tavily:1] Title 1\nContent 1\n— https://a.example.com/path`,
      `[web:tavily:2] Title 2\nContent 2\n— https://b.example.com/other?q=1`,
      `[web:tavily:3] Title 3\nContent 3\n— http://c.example.com`,
    ].join("\n---\n");
    const urls = extractUrlsFromFormattedHits(formatted);
    assert.deepEqual(urls.sort(), [
      "http://c.example.com",
      "https://a.example.com/path",
      "https://b.example.com/other?q=1",
    ]);
  });

  it("ignores URLs not on the `— ` citation line", () => {
    const formatted = `[web:tavily:1] Title\nFor details see https://inline.example.com/page in the body.\n— https://canonical.example.com/citation`;
    assert.deepEqual(
      extractUrlsFromFormattedHits(formatted),
      ["https://canonical.example.com/citation"]
    );
  });

  it("trims trailing whitespace on the URL", () => {
    const formatted = `[web:tavily:1] T\nC\n— https://trimmed.example.com   `;
    assert.deepEqual(
      extractUrlsFromFormattedHits(formatted),
      ["https://trimmed.example.com"]
    );
  });
});

describe("W36 · dedup behaviour (round-trip via formatted hit blocks)", () => {
  // Drive the dedup logic by simulating two calls' formatted outputs
  // sharing one URL. The actual tool integration with blackboard +
  // tavily fetch is exercised by the existing W14 + W16 tests; this
  // suite pins the specific dedup primitive.
  it("URL set built from N formatted blocks contains exactly the unique URLs", () => {
    const block1 = `[web:tavily:1] T1\nC1\n— https://shared.example.com/a\n---\n[web:tavily:2] T2\nC2\n— https://block1-only.example.com/b`;
    const block2 = `[web:tavily:1] T3\nC3\n— https://shared.example.com/a\n---\n[web:tavily:2] T4\nC4\n— https://block2-only.example.com/c`;

    const allUrls = new Set([
      ...extractUrlsFromFormattedHits(block1),
      ...extractUrlsFromFormattedHits(block2),
    ]);
    assert.equal(allUrls.size, 3, "shared URL counted once");
    assert.ok(allUrls.has("https://shared.example.com/a"));
    assert.ok(allUrls.has("https://block1-only.example.com/b"));
    assert.ok(allUrls.has("https://block2-only.example.com/c"));
  });

  it("filtering a hit list by an existingUrls set leaves only new URLs", () => {
    const existingUrls = new Set([
      "https://shared.example.com/a",
      "https://other.example.com/old",
    ]);
    const newHits = [
      { title: "T1", url: "https://shared.example.com/a", content: "x" }, // dropped
      { title: "T2", url: "https://block1-only.example.com/b", content: "y" }, // kept
      { title: "T3", url: "https://block2-only.example.com/c", content: "z" }, // kept
    ];
    const deduped = newHits.filter((h) => !h.url || !existingUrls.has(h.url));
    assert.equal(deduped.length, 2);
    assert.deepEqual(
      deduped.map((h) => h.url).sort(),
      ["https://block1-only.example.com/b", "https://block2-only.example.com/c"]
    );
  });
});
