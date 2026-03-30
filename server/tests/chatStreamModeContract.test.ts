import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Contract: client `mode` must not skip classifyMode — routing is LLM/classifier-only.
 */
describe("chatStream.service mode routing contract", () => {
  it("always invokes classifyMode and does not branch on user mode override", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, "../services/chat/chatStream.service.ts");
    const src = await readFile(path, "utf8");
    assert.match(src, /await classifyMode\(/);
    assert.doesNotMatch(src, /shouldAutoDetect/);
    assert.doesNotMatch(src, /Using user-specified mode/);
  });
});
