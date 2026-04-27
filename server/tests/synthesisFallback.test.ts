import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderFallbackAnswer } from "../lib/agents/runtime/synthesisFallback.js";

/**
 * W3 invariants — `renderFallbackAnswer` must NEVER produce
 *   - the literal `Summary from tool output:` prefix
 *   - the bracketed tool prefix `[execute_query_plan]`
 *   - the `Sample:` keyword used in observation strings
 * regardless of input. The output is the only fallback that can reach the
 * user, so it must be presentable on its own.
 */

const REGION_OBSERVATION =
  '[execute_query_plan] Grouped by Region with sum(Sales)\n' +
  'Rows: 4. Columns: Region, Total_Sales\n' +
  'Sample:\n' +
  '[\n' +
  '  { "Region": "West", "Total_Sales": 710212.4044999994 },\n' +
  '  { "Region": "East", "Total_Sales": 669518.7259999993 },\n' +
  '  { "Region": "Central", "Total_Sales": 492646.91320000065 },\n' +
  '  { "Region": "South", "Total_Sales": 389151.4590000006 }\n' +
  ']';

describe("renderFallbackAnswer (Wave W3)", () => {
  it("renders the latest Sample[] block as a markdown table", () => {
    const out = renderFallbackAnswer([REGION_OBSERVATION]);
    assert.ok(out.tableMarkdown, "expected a table to be rendered");
    assert.match(out.tableMarkdown!, /\| Region \| Total_Sales \|/);
    assert.match(out.tableMarkdown!, /\| --- \| --- \|/);
    assert.match(out.tableMarkdown!, /\| West \| 710,212\.40 \|/);
    assert.match(out.tableMarkdown!, /\| South \| 389,151\.46 \|/);
  });

  it("never emits the literal 'Summary from tool output:' prefix", () => {
    const out = renderFallbackAnswer([REGION_OBSERVATION]);
    assert.ok(
      !out.content.includes("Summary from tool output:"),
      "fallback content must not echo the legacy dump prefix"
    );
  });

  it("never emits the bracketed tool prefix '[execute_query_plan]'", () => {
    const out = renderFallbackAnswer([REGION_OBSERVATION]);
    assert.ok(
      !out.content.includes("[execute_query_plan]"),
      "fallback content must not echo internal tool prefixes"
    );
  });

  it("never emits the literal 'Sample:' keyword", () => {
    const out = renderFallbackAnswer([REGION_OBSERVATION]);
    assert.ok(
      !out.content.includes("Sample:"),
      "fallback content must not echo the observation 'Sample:' keyword"
    );
  });

  it("opens with the user-facing apology when a table was rendered", () => {
    const out = renderFallbackAnswer([REGION_OBSERVATION]);
    assert.match(
      out.content,
      /^I retrieved the data but couldn't generate a written summary\./,
      "fallback content must lead with the apology when a table is available"
    );
  });

  it("returns a one-line apology when no Sample[] block exists", () => {
    const out = renderFallbackAnswer([
      "[some_tool] Did some work\nNo structured rows available.",
    ]);
    assert.equal(out.tableMarkdown, null);
    assert.equal(
      out.content,
      "Synthesis failed; please retry the question or rephrase."
    );
  });

  it("returns a one-line apology when the array fails to parse", () => {
    const out = renderFallbackAnswer([
      "[execute_query_plan] Grouped by Region\nSample: [ this is not JSON ]",
    ]);
    assert.equal(out.tableMarkdown, null);
    assert.match(out.content, /Synthesis failed/);
  });

  it("returns a one-line apology when the array is empty", () => {
    const out = renderFallbackAnswer([
      "[execute_query_plan] empty result\nSample: []",
    ]);
    assert.equal(out.tableMarkdown, null);
  });

  it("walks observations newest→oldest and uses the last parseable Sample", () => {
    const old =
      '[execute_query_plan] old result\nSample: [{"Foo":"a","Bar":1}]';
    const newer = REGION_OBSERVATION;
    const out = renderFallbackAnswer([old, newer]);
    assert.ok(out.tableMarkdown, "expected a table");
    assert.match(out.tableMarkdown!, /\| Region \| Total_Sales \|/);
    assert.ok(
      !out.tableMarkdown!.includes("| Foo |"),
      "should prefer the newer observation's Sample"
    );
  });

  it("caps rendered rows at 50", () => {
    const big = Array.from({ length: 80 }, (_, i) => ({
      idx: i,
      val: i * 1.5,
    }));
    const obs = `[execute_query_plan] big result\nSample: ${JSON.stringify(big)}`;
    const out = renderFallbackAnswer([obs]);
    assert.ok(out.tableMarkdown);
    const rowCount =
      (out.tableMarkdown!.match(/\n\| \d/g) ?? []).length; // data rows start with `| <number>`
    assert.ok(
      rowCount <= 50,
      `expected ≤50 rendered data rows, got ${rowCount}`
    );
  });

  it("formats integers with comma grouping and floats with two decimals", () => {
    const obs =
      '[execute_query_plan] Sales\nSample: [{"Region":"X","RowCount":1000000,"Avg":1234.567}]';
    const out = renderFallbackAnswer([obs]);
    assert.ok(out.tableMarkdown);
    assert.match(out.tableMarkdown!, /\| X \| 1,000,000 \| 1,234\.57 \|/);
  });

  it("escapes pipes in cell values so they do not break the table", () => {
    const obs =
      '[execute_query_plan] x\nSample: [{"Label":"a|b","N":1}]';
    const out = renderFallbackAnswer([obs]);
    assert.ok(out.tableMarkdown);
    assert.ok(
      out.tableMarkdown!.includes("a\\|b"),
      "pipes inside cells must be escaped"
    );
  });

  it("returns no-table apology when observations is empty", () => {
    const out = renderFallbackAnswer([]);
    assert.equal(out.tableMarkdown, null);
    assert.match(out.content, /Synthesis failed/);
  });
});
