import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CITATION_TOKEN_RE,
  extractCitations,
  formatCitationLabel,
  listCitedPackIds,
} from "./citationTokens.js";

/**
 * Wave WQ3 · client-side detector for backtick-wrapped domain-pack citation
 * tokens. Pins the contract between this helper and the server-side W22
 * `CITATION_TOKEN_RE` ([server/lib/agents/runtime/checkEnvelopeCompleteness.ts:120](../../../server/lib/agents/runtime/checkEnvelopeCompleteness.ts)).
 * Drift between the two regexes silently breaks the hover-card surfacing,
 * so the tests below pin both the regex and the hyphen-rule heuristic.
 *
 * Coverage:
 *  - Regex parity with W22's server side: same pattern, same length floor.
 *  - Hyphen rule filters generic backtick spans (column names, acronyms).
 *  - Extraction preserves the input text bytewise via segment concatenation.
 *  - Adjacent citations, leading citations, trailing citations.
 *  - listCitedPackIds dedupes in first-occurrence order.
 *  - formatCitationLabel humanises kebab-case for the hover-card header.
 */

describe("Wave WQ3 · CITATION_TOKEN_RE parity with W22 server regex", () => {
  it("matches backtick-wrapped lowercase identifiers with ≥5 chars", () => {
    // Same source as server/lib/agents/runtime/checkEnvelopeCompleteness.ts:120
    assert.equal(CITATION_TOKEN_RE.source, "`([a-z][a-z0-9-]{4,})`");
  });

  it("regex itself ignores tokens shorter than 5 chars (anchor: server heuristic)", () => {
    const re = new RegExp(CITATION_TOKEN_RE.source);
    assert.equal(re.test("`mt`"), false, "2-char token rejected by length floor");
    assert.equal(re.test("`abcd`"), false, "4-char token rejected by length floor");
    assert.equal(re.test("`abcde`"), true, "5-char token accepted");
  });
});

describe("Wave WQ3 · extractCitations hyphen rule (mirrors W22 false-positive filter)", () => {
  it("treats `marico-haircare-portfolio` as a citation (has hyphen)", () => {
    const segments = extractCitations("Per `marico-haircare-portfolio`, MT is the trade metric.");
    const cits = segments.filter((s) => s.type === "citation");
    assert.equal(cits.length, 1);
    if (cits[0].type !== "citation") throw new Error("unreachable");
    assert.equal(cits[0].packId, "marico-haircare-portfolio");
    assert.equal(cits[0].raw, "`marico-haircare-portfolio`");
  });

  it("does NOT treat `Volume_MT` as a citation (no hyphen, also caps)", () => {
    const segments = extractCitations("Use the `Volume_MT` column.");
    const cits = segments.filter((s) => s.type === "citation");
    assert.equal(cits.length, 0, "underscores + caps are NOT pack ids");
  });

  it("does NOT treat `mtsales` as a citation (≥5 chars but no hyphen)", () => {
    const segments = extractCitations("The `mtsales` figure is up.");
    const cits = segments.filter((s) => s.type === "citation");
    assert.equal(cits.length, 0, "hyphen-less lowercase tokens are NOT pack ids");
  });

  it("does NOT treat short tokens as citations even with hyphens", () => {
    const segments = extractCitations("Use `a-b` here.");
    const cits = segments.filter((s) => s.type === "citation");
    assert.equal(cits.length, 0, "tokens under 5 chars are NOT pack ids");
  });
});

describe("Wave WQ3 · extractCitations segment shape", () => {
  it("empty input → empty array", () => {
    assert.deepEqual(extractCitations(""), []);
  });

  it("no citations → single text segment containing the whole input", () => {
    const segments = extractCitations("MT volume rolled by Region.");
    assert.deepEqual(segments, [{ type: "text", value: "MT volume rolled by Region." }]);
  });

  it("text + citation + text → three segments in order", () => {
    const segments = extractCitations("Per `marico-haircare-portfolio`, MT leads.");
    assert.equal(segments.length, 3);
    assert.deepEqual(segments[0], { type: "text", value: "Per " });
    assert.equal(segments[1].type, "citation");
    assert.deepEqual(segments[2], { type: "text", value: ", MT leads." });
  });

  it("preserves input bytewise via concatenation", () => {
    const input = "Per `marico-haircare-portfolio` and `kpi-and-metric-glossary`, MT leads.";
    const segments = extractCitations(input);
    const reconstructed = segments
      .map((s) => (s.type === "text" ? s.value : s.raw))
      .join("");
    assert.equal(reconstructed, input);
  });

  it("handles leading citation (no preceding text segment)", () => {
    const segments = extractCitations("`marico-haircare-portfolio` is the source.");
    assert.equal(segments[0].type, "citation");
    assert.equal(segments[1].type, "text");
  });

  it("handles trailing citation (no following text segment)", () => {
    const segments = extractCitations("Source: `marico-haircare-portfolio`");
    assert.equal(segments[segments.length - 1].type, "citation");
    assert.equal(segments[0].type, "text");
  });

  it("adjacent citations → consecutive citation segments", () => {
    const segments = extractCitations("`marico-haircare-portfolio``kpi-and-metric-glossary`");
    const types = segments.map((s) => s.type);
    assert.deepEqual(types, ["citation", "citation"]);
  });

  it("fresh regex state per call (no lastIndex bleed across invocations)", () => {
    const a = extractCitations("Per `marico-haircare-portfolio`, MT.");
    const b = extractCitations("Per `marico-haircare-portfolio`, MT.");
    assert.deepEqual(
      a.map((s) => s.type),
      b.map((s) => s.type),
      "two identical inputs must produce identical segment shapes",
    );
  });
});

describe("Wave WQ3 · listCitedPackIds dedupes in first-occurrence order", () => {
  it("returns [] for text without citations", () => {
    assert.deepEqual(listCitedPackIds("plain prose with no citations"), []);
  });

  it("dedupes repeated citations of the same pack id", () => {
    const ids = listCitedPackIds(
      "Per `marico-haircare-portfolio`, MT is the metric. Again per `marico-haircare-portfolio`, …",
    );
    assert.deepEqual(ids, ["marico-haircare-portfolio"]);
  });

  it("preserves first-occurrence order across distinct ids", () => {
    const ids = listCitedPackIds(
      "Per `kpi-and-metric-glossary` and `marico-haircare-portfolio`, MT is the trade metric. " +
        "Re-citing `kpi-and-metric-glossary` does NOT push it later.",
    );
    assert.deepEqual(ids, ["kpi-and-metric-glossary", "marico-haircare-portfolio"]);
  });
});

describe("Wave WQ3 · formatCitationLabel humanises kebab-case", () => {
  it("title-cases each hyphen-separated word", () => {
    assert.equal(
      formatCitationLabel("marico-haircare-portfolio"),
      "Marico Haircare Portfolio",
    );
    assert.equal(formatCitationLabel("kpi-and-metric-glossary"), "Kpi And Metric Glossary");
  });

  it("handles single-word labels gracefully", () => {
    // Single-word IDs without a hyphen technically would not be treated as
    // citations by extractCitations, but formatCitationLabel must still
    // behave for any string input (e.g. label called directly with a
    // hand-supplied ID).
    assert.equal(formatCitationLabel("portfolio"), "Portfolio");
  });

  it("returns empty for empty / whitespace-only input", () => {
    assert.equal(formatCitationLabel(""), "");
    assert.equal(formatCitationLabel("---"), "");
  });
});
