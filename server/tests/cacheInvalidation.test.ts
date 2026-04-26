import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * W5.4 · Verify the runtime cache lookup filters cannot return stale rows.
 *
 * The cache lookup MUST always pin to the session's current dataVersion. A
 * regression where someone removed `dataVersion eq @v` from the filter would
 * silently serve answers from prior data versions — a correctness bug. These
 * tests inspect the actual filter strings in the source rather than relying
 * on a live AI Search round-trip.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE = readFileSync(
  path.join(__dirname, "..", "lib", "rag", "pastAnalysesStore.ts"),
  "utf8"
);

describe("W5.4 · cache lookup filters always include dataVersion", () => {
  it("findExactPastAnalysisMatch filter includes `dataVersion eq` clause", () => {
    // Find the function block then check its filter parts
    const fnStart = STORE.indexOf("export async function findExactPastAnalysisMatch");
    assert.ok(fnStart > -1, "findExactPastAnalysisMatch function not found");
    const fnEnd = STORE.indexOf("\nexport ", fnStart + 1);
    const fnBody = STORE.slice(fnStart, fnEnd > -1 ? fnEnd : STORE.length);
    assert.match(
      fnBody,
      /dataVersion eq \$\{params\.dataVersion\}/,
      "exact-match filter must pin dataVersion to the call's value"
    );
  });

  it("findSimilarPastAnalyses filter includes `dataVersion eq` clause", () => {
    const fnStart = STORE.indexOf("export async function findSimilarPastAnalyses");
    assert.ok(fnStart > -1, "findSimilarPastAnalyses function not found");
    const fnEnd = STORE.indexOf("\nexport ", fnStart + 1);
    const fnBody = STORE.slice(fnStart, fnEnd > -1 ? fnEnd : STORE.length);
    assert.match(
      fnBody,
      /dataVersion eq \$\{params\.dataVersion\}/,
      "semantic filter must pin dataVersion to the call's value"
    );
  });

  it("both lookup functions exclude thumbs-down rows", () => {
    const exact = STORE.slice(
      STORE.indexOf("export async function findExactPastAnalysisMatch"),
      STORE.indexOf("export async function findSimilarPastAnalyses")
    );
    const sim = STORE.slice(
      STORE.indexOf("export async function findSimilarPastAnalyses")
    );
    assert.match(exact, /feedback ne 'down'/, "exact-match filter must exclude thumbs-down");
    assert.match(sim, /feedback ne 'down'/, "semantic filter must exclude thumbs-down");
  });

  it("both lookup functions exclude failed turns", () => {
    const exact = STORE.slice(
      STORE.indexOf("export async function findExactPastAnalysisMatch"),
      STORE.indexOf("export async function findSimilarPastAnalyses")
    );
    const sim = STORE.slice(
      STORE.indexOf("export async function findSimilarPastAnalyses")
    );
    assert.match(exact, /outcome eq 'ok'/, "exact-match filter must require outcome=ok");
    assert.match(sim, /outcome eq 'ok'/, "semantic filter must require outcome=ok");
  });
});
