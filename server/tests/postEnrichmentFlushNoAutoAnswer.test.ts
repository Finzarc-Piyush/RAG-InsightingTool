import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Guard: after the early-question fix, the CLIENT re-fires an early question as
 * a normal streaming turn once the data is ready. `postEnrichmentFlush` must
 * therefore NOT auto-answer (its old `processChatMessage` call produced a
 * non-streaming reply the client never displayed, and depended on an unlocked
 * `pendingUserMessage` RMW that could be lost). Source-inspection because the
 * function dynamically imports Cosmos-backed model code that can't be unit-run.
 */
describe("postEnrichmentFlush no longer auto-answers", () => {
  const servicePath = fileURLToPath(
    new URL("../services/chat/chat.service.ts", import.meta.url)
  );

  it("does not call processChatMessage from inside postEnrichmentFlush", async () => {
    const src = await readFile(servicePath, "utf8");
    const start = src.indexOf("export async function postEnrichmentFlush");
    assert.ok(start >= 0, "postEnrichmentFlush should still exist");
    // The function is the last export in the file; inspect to end-of-file.
    const body = src.slice(start);
    assert.ok(
      !/processChatMessage\s*\(/.test(body),
      "postEnrichmentFlush must NOT invoke processChatMessage (client owns the re-fire)"
    );
  });
});
