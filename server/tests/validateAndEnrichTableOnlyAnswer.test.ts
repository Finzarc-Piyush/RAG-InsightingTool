/**
 * Quick-lookup table-only contract · `validateAndEnrichResponse` must NOT reject
 * a successful fast-lane result.
 *
 * The quick-lookup fast lane (quickAnswerPath.ts) returns `answer: ""` + a
 * populated `table` by design ("the preview table IS the answer"). The shared
 * response gate previously threw `Empty answer from answerQuestion` on any empty
 * answer, so a successful simple lookup (e.g. "show me top 10 X by Y" → 10 rows)
 * surfaced to the user as an error. The gate now synthesizes a concise one-line
 * answer from the plan rationale when the answer is empty but a table is present.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAndEnrichResponse } from "../services/chat/chatResponse.service.js";
import type { ChatDocument } from "../shared/schema.js";

const chatDoc = {
  id: "ql-tableonly-fixture",
  sessionId: "ql-tableonly-fixture",
  dataSummary: {
    rowCount: 10,
    columnCount: 2,
    columns: [
      { name: "TSO_TSE Name", type: "string", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: [],
  },
} as unknown as ChatDocument;

const tableRows = Array.from({ length: 10 }, (_, i) => ({
  "TSO_TSE Name": `Rep ${i + 1}`,
  "Compliance Visit": 100 - i,
}));

describe("validateAndEnrichResponse · quick-lookup table-only result", () => {
  it("does NOT throw, leads with the plan rationale, and renders the rows as a markdown table", () => {
    const result = {
      answer: "",
      table: tableRows,
      charts: [],
      insights: [],
      agentTrace: { planRationale: "Top 10 TSOE names by Compliance Visit" },
    };
    const validated = validateAndEnrichResponse(result, chatDoc);
    const answer = (validated as { answer?: string }).answer ?? "";
    assert.ok(
      answer.startsWith("Top 10 TSOE names by Compliance Visit"),
      "answer must lead with the plan rationale, not be rejected as empty",
    );
    // The actual rows must be surfaced inline as a GFM table (the data the user
    // asked for), not just a bare title.
    assert.match(answer, /\|\s*TSO_TSE Name\s*\|\s*Compliance Visit\s*\|/);
    assert.match(answer, /\|\s*---\s*\|\s*---\s*\|/);
    assert.match(answer, /\|\s*Rep 1\s*\|\s*100\s*\|/);
    assert.match(answer, /\|\s*Rep 10\s*\|\s*91\s*\|/);
  });

  it("falls back to a generic title but still renders the table when no plan rationale is present", () => {
    const result = { answer: "", table: tableRows, charts: [], insights: [] };
    const validated = validateAndEnrichResponse(result, chatDoc);
    const answer = (validated as { answer?: string }).answer ?? "";
    assert.ok(answer.startsWith("Here are the results."));
    assert.match(answer, /\|\s*Rep 1\s*\|\s*100\s*\|/);
  });

  it("still throws on a genuinely empty result (no answer AND no table)", () => {
    assert.throws(
      () => validateAndEnrichResponse({ answer: "", charts: [], insights: [] }, chatDoc),
      /Empty answer/,
    );
  });

  it("leaves a normal narrated answer untouched", () => {
    const result = {
      answer: "Rep 1 leads with 100 compliance visits.",
      table: tableRows,
      charts: [],
      insights: [],
      agentTrace: { planRationale: "should not override" },
    };
    const validated = validateAndEnrichResponse(result, chatDoc);
    assert.equal(
      (validated as { answer?: string }).answer,
      "Rep 1 leads with 100 compliance visits.",
    );
  });
});
