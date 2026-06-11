import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * P2/P3/P4 regression · The ChatDocument write seam.
 *
 * `mutateChatDocument` is THE read-modify-write seam: it acquires the unified
 * `withSessionWriteLock`, reads the doc FRESH (bypassing the 5 s cache so the
 * `_etag` is current), runs the mutator, writes with an IfMatch `_etag`
 * precondition, and retries on a 412 (cross-instance optimistic concurrency).
 *
 * The historically UNLOCKED writers (message append, turn checkpoint) and the
 * stale-snapshot-prone ones (BAI patch, SAC merge) must route through it, or the
 * last-writer-wins corruption that invariant #9 / Wave A2 fought returns. These
 * are source-level guards (the writers depend on a live Cosmos container, so we
 * pin the architecture rather than drive a real client).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("P2 · mutateChatDocument seam (lock + ETag + 412 retry)", () => {
  const src = read("models/chat.model.ts");

  it("exports mutateChatDocument", () => {
    assert.match(src, /export const mutateChatDocument\s*=/);
  });

  it("acquires withSessionWriteLock", () => {
    const fn = src.slice(src.indexOf("export const mutateChatDocument"));
    assert.match(fn, /withSessionWriteLock\(\s*sessionId/);
  });

  it("reads FRESH (forceRefresh) so the _etag is current", () => {
    const fn = src.slice(src.indexOf("export const mutateChatDocument"));
    assert.match(fn, /getChatBySessionIdEfficient\(\s*sessionId\s*,\s*\/\* forceRefresh \*\/\s*true\s*\)/);
  });

  it("writes with an IfMatch _etag precondition", () => {
    const fn = src.slice(src.indexOf("export const mutateChatDocument"));
    assert.match(fn, /updateChatDocument\(\s*doc\s*,\s*\{\s*ifMatchEtag:\s*doc\._etag\s*\}\s*\)/);
  });

  it("retries on a 412 precondition failure", () => {
    const fn = src.slice(src.indexOf("export const mutateChatDocument"));
    assert.match(fn, /isPreconditionFailed\(err\)/);
    assert.match(src, /function isPreconditionFailed[\s\S]*?412/);
  });

  it("updateChatDocument passes accessCondition only when an ifMatchEtag is supplied", () => {
    const fn = src.slice(
      src.indexOf("export const updateChatDocument"),
      src.indexOf("export const mutateChatDocument")
    );
    assert.match(fn, /accessCondition:\s*\{\s*type:\s*["']IfMatch["']/);
    assert.match(fn, /options\?\.ifMatchEtag/);
  });
});

describe("P2 · previously-unlocked / stale-snapshot writers route through the seam", () => {
  it("addMessagesBySessionId uses mutateChatDocument (was an unlocked get→push→upsert)", () => {
    const src = read("models/chat.model.ts");
    const fn = src.slice(src.indexOf("export const addMessagesBySessionId"));
    assert.match(fn.slice(0, fn.indexOf("};")), /mutateChatDocument\(\s*sessionId/);
  });

  it("turnCheckpoint write + clear go through mutateChatDocument (was unlocked)", () => {
    const src = read("lib/turnCheckpoint.ts");
    assert.match(src, /import \{ mutateChatDocument \}/);
    // Both writeCheckpoint and clearTurnCheckpoint must use the seam.
    const matches = src.match(/mutateChatDocument\(/g) ?? [];
    assert.ok(matches.length >= 2, "both writeCheckpoint and clearTurnCheckpoint must use mutateChatDocument");
    assert.doesNotMatch(src, /updateChatDocument\(/, "turnCheckpoint must not call updateChatDocument directly anymore");
  });

  it("patchAssistantBusinessActions uses mutateChatDocument (was its own doPatch RMW)", () => {
    const src = read("lib/patchAssistantBusinessActions.ts");
    assert.match(src, /mutateChatDocument\(\s*params\.sessionId/);
    assert.doesNotMatch(src, /async function doPatch/);
  });

  it("persistMergeAssistantSessionContext (SAC merge) uses mutateChatDocument field-scoped", () => {
    const src = read("lib/sessionAnalysisContext.ts");
    const fn = src.slice(src.indexOf("export async function persistMergeAssistantSessionContext"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /mutateChatDocument\(\s*params\.sessionId/);
    // The merge writes only sessionAnalysisContext on the fresh doc.
    assert.match(body, /doc\.sessionAnalysisContext = next/);
    assert.doesNotMatch(body, /async function doPersist/);
  });
});

describe("P2 · turnCheckpoint 'turn finished' sentinel prevents resurrection", () => {
  const src = read("lib/turnCheckpoint.ts");
  it("tracks finished turns and aborts a late write under the lock", () => {
    assert.match(src, /finishedTurns\s*=\s*new Set<string>\(\)/);
    assert.match(src, /finishedTurns\.add\(sessionId\)/); // clearTurnCheckpoint
    assert.match(src, /finishedTurns\.delete\(opts\.sessionId\)/); // scheduleTurnCheckpoint
    assert.match(src, /if \(finishedTurns\.has\(sessionId\)\) return false/); // writeCheckpoint mutator
  });
});
