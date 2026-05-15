import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Wave A6 · Pins the contract that RAG indexing captures `dataVersion`
 * at spawn time, and that all three Cosmos writes to `ragIndex` go
 * through a locked, targeted `updateRagIndexField` helper instead of a
 * stale-snapshot full-doc `updateChatDocument(doc)` call.
 *
 * Pre-A6 the indexing flow was:
 *   1. read doc
 *   2. set ragIndex.status = "indexing"
 *   3. updateChatDocument(doc)  // ← writes WHOLE doc back
 *   4. embed for ~3s (concurrent paths can mutate doc in Cosmos here)
 *   5. set ragIndex.status = "ready" + new dataVersion
 *   6. updateChatDocument(doc)  // ← clobbers concurrent changes
 *
 * Now (post-A6):
 *   1. read doc
 *   2. `ver = dataVersion(doc)` captured immediately
 *   3. updateRagIndexField(status: "indexing")  // ← lock + re-fetch + targeted write
 *   4. embed for ~3s
 *   5. updateRagIndexField(status: "ready", dataVersion: ver)  // ← lock + re-fetch + targeted write
 *
 * The embeddings are still tagged with the version of the data we
 * actually SAMPLED at step 1 — not a later version that bumped during
 * the embedding phase. The Cosmos write at step 5 only touches the
 * `ragIndex` field; any concurrent writes to `messages[]`,
 * `sessionAnalysisContext`, `dataSummary`, etc. are preserved.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const indexSessionSrc = resolve(
  __dirname,
  "..",
  "lib",
  "rag",
  "indexSession.ts"
);

describe("Wave A6 · RAG indexing uses the unified write lock for ragIndex writes", () => {
  it("indexSession.ts imports withSessionWriteLock from the unified module", () => {
    const src = readFileSync(indexSessionSrc, "utf8");
    assert.match(
      src,
      /import\s*\{\s*withSessionWriteLock\s*\}\s*from\s*['"]\.\.\/sessionWriteLock\.js['"]/,
      "indexSession.ts must import withSessionWriteLock"
    );
  });

  it("declares a `updateRagIndexField` helper that uses the lock + re-fetches the doc", () => {
    const src = readFileSync(indexSessionSrc, "utf8");
    assert.match(
      src,
      /async\s+function\s+updateRagIndexField/,
      "updateRagIndexField helper must exist"
    );
    // The helper must acquire the lock AND re-fetch before mutating.
    const helperMatch = src.match(
      /async\s+function\s+updateRagIndexField[\s\S]+?^\}/m
    );
    assert.ok(helperMatch, "updateRagIndexField body must be findable");
    assert.match(
      helperMatch![0],
      /withSessionWriteLock\s*\(\s*sessionId\s*,/,
      "updateRagIndexField must wrap its body in withSessionWriteLock"
    );
    assert.match(
      helperMatch![0],
      /getChatBySessionIdEfficient\s*\(\s*sessionId\s*\)/,
      "updateRagIndexField must re-fetch inside the lock so concurrent changes are preserved"
    );
  });

  it("indexSessionRag captures `ver` BEFORE the long-running embedding phase", () => {
    const src = readFileSync(indexSessionSrc, "utf8");
    const fnMatch = src.match(
      /export\s+async\s+function\s+indexSessionRag[\s\S]+?^\}/m
    );
    assert.ok(fnMatch, "indexSessionRag body must be findable");
    const body = fnMatch![0];
    const verIdx = body.indexOf("dataVersion(doc)");
    const embedIdx = body.indexOf("embedTexts(");
    assert.ok(verIdx > 0, "indexSessionRag must call dataVersion(doc)");
    assert.ok(embedIdx > 0, "indexSessionRag must call embedTexts");
    assert.ok(
      verIdx < embedIdx,
      `dataVersion(doc) must be captured BEFORE embedTexts; got ver@${verIdx} embed@${embedIdx}`
    );
  });

  it("indexSessionRag uses `updateRagIndexField` for all status writes (no direct updateChatDocument in the body)", () => {
    const src = readFileSync(indexSessionSrc, "utf8");
    const fnMatch = src.match(
      /export\s+async\s+function\s+indexSessionRag[\s\S]+?^\}/m
    );
    assert.ok(fnMatch, "indexSessionRag body must be findable");
    const body = fnMatch![0];
    // Should contain updateRagIndexField at least 2× (indexing + ready/error).
    const updateFieldCount = (body.match(/updateRagIndexField/g) ?? []).length;
    assert.ok(
      updateFieldCount >= 2,
      `indexSessionRag must call updateRagIndexField at least twice (got ${updateFieldCount})`
    );
    // Should NOT contain direct updateChatDocument calls — the helper handles those.
    assert.doesNotMatch(
      body,
      /^\s*await\s+updateChatDocument\s*\(/m,
      "indexSessionRag must NOT call updateChatDocument directly — go through updateRagIndexField"
    );
  });
});
