/**
 * Wave R4 · free, key-less web-search providers.
 *
 * Unit-tests the pure pieces — provider key gating and the Wikipedia / GDELT
 * response parsers — without hitting the network. The provider HTTP wrappers
 * and the `auto` dispatcher compose these parsers; their network behaviour is
 * exercised manually / in the live app, not in unit tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { providerNeedsKey, parseWikipediaResults, parseGdeltResults } =
  await import("../lib/agents/runtime/tools/webSearchTool.js");

describe("R4 · providerNeedsKey", () => {
  it("requires a key only for key-bearing providers", () => {
    assert.equal(providerNeedsKey("tavily"), true);
    assert.equal(providerNeedsKey("brave"), true);
    assert.equal(providerNeedsKey("auto"), false);
    assert.equal(providerNeedsKey("wikipedia"), false);
    assert.equal(providerNeedsKey("gdelt"), false);
  });
});

describe("R4 · parseWikipediaResults", () => {
  it("maps search results to {title, url, content} with HTML stripped", () => {
    const json = {
      query: {
        search: [
          { title: "Marico", snippet: "<span>Indian <b>FMCG</b> company</span>" },
          { title: "Saffola Oil", snippet: "Edible oil &amp; brand" },
        ],
      },
    };
    const hits = parseWikipediaResults(json, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].title, "Marico");
    assert.equal(hits[0].url, "https://en.wikipedia.org/wiki/Marico");
    assert.equal(hits[0].content, "Indian FMCG company");
    assert.equal(hits[1].url, "https://en.wikipedia.org/wiki/Saffola_Oil");
    assert.equal(hits[1].content, "Edible oil & brand");
  });

  it("respects maxResults and tolerates a missing shape", () => {
    const json = { query: { search: [{ title: "A" }, { title: "B" }, { title: "C" }] } };
    assert.equal(parseWikipediaResults(json, 2).length, 2);
    assert.deepEqual(parseWikipediaResults({}, 5), []);
    assert.deepEqual(parseWikipediaResults(null, 5), []);
  });
});

describe("R4 · parseGdeltResults", () => {
  it("maps articles to {title, url, content} with domain + seendate", () => {
    const json = {
      articles: [
        {
          title: "Retail slump in Q2",
          url: "https://news.example.com/q2",
          domain: "news.example.com",
          seendate: "20240701T120000Z",
        },
      ],
    };
    const hits = parseGdeltResults(json, 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Retail slump in Q2");
    assert.equal(hits[0].url, "https://news.example.com/q2");
    assert.match(hits[0].content, /news\.example\.com/);
    assert.match(hits[0].content, /seen 20240701/);
  });

  it("drops articles missing a url and tolerates a missing shape", () => {
    const json = { articles: [{ title: "no url" }, { title: "ok", url: "https://x.com" }] };
    assert.equal(parseGdeltResults(json, 5).length, 1);
    assert.deepEqual(parseGdeltResults({}, 5), []);
    assert.deepEqual(parseGdeltResults(undefined, 5), []);
  });
});
