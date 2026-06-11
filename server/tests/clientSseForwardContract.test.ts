import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * P1 regression · The client SSE dispatcher (`dispatchEvent` in
 * client/src/lib/api/chat.ts) must FORWARD-BY-DEFAULT: any server event without
 * a dedicated `case` is handed to `onAgentEvent`. A curated allow-list with a
 * bare `default: break` silently dropped seven live-update events the server
 * emits and `useHomeMutations.onAgentEvent` handles (business_actions,
 * session_context_updated, workbench_enriched, persist_status, answer_chunk,
 * directive_added, context_trimmed) — the "my edits aren't reflected at
 * runtime" bug: editing those handlers had no effect because the event never
 * arrived. This is a SOURCE-LEVEL guard (chat.ts is not node-loadable — it uses
 * Vite `@/` aliases + MSAL).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTsPath = resolve(
  __dirname,
  "..",
  "..",
  "client",
  "src",
  "lib",
  "api",
  "chat.ts"
);
const useHomeMutationsPath = resolve(
  __dirname,
  "..",
  "..",
  "client",
  "src",
  "pages",
  "Home",
  "modules",
  "useHomeMutations.ts"
);

describe("P1 · client dispatchEvent forwards unknown agent events", () => {
  const src = readFileSync(chatTsPath, "utf8");

  it("dispatchEvent's default branch forwards to onAgentEvent (not a bare break)", () => {
    const start = src.indexOf("function dispatchEvent(");
    assert.ok(start >= 0, "dispatchEvent must exist in chat.ts");
    // Bound the region to the dispatchEvent function (ends where the next
    // top-level function begins) so we don't pick up the deprecated data-ops
    // dispatcher.
    const end = src.indexOf("function handleTrailingBuffer(", start);
    assert.ok(end > start, "could not bound the dispatchEvent function body");
    const region = src.slice(start, end);
    const defaultIdx = region.lastIndexOf("default:");
    assert.ok(defaultIdx >= 0, "dispatchEvent must have a default branch");
    const defaultBranch = region.slice(defaultIdx);
    assert.match(
      defaultBranch,
      /onAgentEvent\?\.\(/,
      "dispatchEvent's default branch must forward unknown events to onAgentEvent — a bare `default: break` silently drops business_actions / session_context_updated / workbench_enriched / persist_status / answer_chunk / directive_added / context_trimmed"
    );
  });

  it("useHomeMutations.onAgentEvent still handles the previously-dropped events (so forwarding is meaningful)", () => {
    const src2 = readFileSync(useHomeMutationsPath, "utf8");
    for (const evt of [
      "business_actions",
      "session_context_updated",
      "workbench_enriched",
      "persist_status",
      "answer_chunk",
    ]) {
      assert.match(
        src2,
        new RegExp(`event === ['"]${evt}['"]`),
        `useHomeMutations.onAgentEvent must keep its handler for '${evt}' (now reachable via the forward-by-default dispatcher)`
      );
    }
  });
});
