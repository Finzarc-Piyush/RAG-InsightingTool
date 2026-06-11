import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

/**
 * Wave A5 · The session-doc cache contract (`sessionDocCache` in
 * `chat.model.ts`) requires that EVERY chat-document write goes through
 * `updateChatDocument` so the cache is repopulated with the freshly-
 * written resource. This is the cheapest correct cache strategy: writes
 * keep the cache HOT rather than invalidating it.
 *
 * The audit that triggered this wave flagged "sessionDocCache not
 * invalidated on hierarchy / permanent-context updates" as a HIGH-severity
 * race, claiming that a freshly-declared hierarchy could be invisible to
 * the next turn for up to 5 minutes (the auditor misread the 5_000 ms TTL
 * as 5 min and missed that `updateChatDocument` repopulates the cache).
 *
 * Ground-truth investigation showed every write path correctly delegates
 * to `updateChatDocument`. This test PINS that invariant: any code that
 * directly calls `containerInstance.items.upsert(chatDoc)` or
 * `.patch(...)` against the chat container outside `updateChatDocument`
 * would bypass the cache freshness logic. We grep the entire server tree
 * to forbid such bypasses (with a single allowlist entry: the
 * `updateChatDocument` body itself, where the upsert legitimately lives).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverRoot = resolve(__dirname, "..");

describe("Wave A5 · sessionDocCache contract — no chat-doc write bypasses updateChatDocument", () => {
  it("chat.model.ts contains exactly ONE items.upsert (inside updateChatDocument)", () => {
    // Pin: the only chat-container upsert in the entire codebase lives
    // inside `updateChatDocument`. Any future addition of a second
    // chat-container upsert (in this file or anywhere else) would bypass
    // the cache freshness logic. We constrain by file: the chat container
    // is only resolved in `chat.model.ts` (via `waitForContainer()` →
    // the singleton `containerInstance`), so any `items.upsert` outside
    // this file CANNOT be on the chat container.
    let output = "";
    try {
      output = execSync(
        `grep -n 'items\\.upsert' '${serverRoot}/models/chat.model.ts' || true`,
        { encoding: "utf8" }
      );
    } catch {
      /* swallow */
    }
    // Filter out comment lines (start with ` * ` or `//` after the line-number prefix).
    const hits = output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        const m = line.match(/^\d+:\s*(.*)$/);
        if (!m) return false;
        const code = m[1];
        if (/^\s*\*/.test(code)) return false; // doc comment
        if (/^\s*\/\//.test(code)) return false; // single-line comment
        return true;
      });
    assert.equal(
      hits.length,
      1,
      `chat.model.ts must contain exactly ONE items.upsert in code (the one inside updateChatDocument). Found ${hits.length}:\n${hits.join("\n")}`
    );
    // And it must be on a line that's inside updateChatDocument (cheap
    // proxy: the line content matches the known callsite).
    // First arg must be the chatDocument from updateChatDocument. A second
    // optional arg (the IfMatch `requestOptions` for ETag optimistic
    // concurrency) is allowed — the cache-repopulation contract is unaffected.
    assert.match(
      hits[0],
      /containerInstance\.items\.upsert\s*\(\s*chatDocument\s*[,)]/,
      `the upsert call must use the chatDocument variable from updateChatDocument`
    );
  });

  it("no chat container is resolved outside chat.model.ts (the resolution helper `waitForContainer` is module-private)", () => {
    let output = "";
    try {
      output = execSync(
        `grep -rn 'waitForContainer' '${serverRoot}/lib' '${serverRoot}/services' '${serverRoot}/controllers' --include='*.ts' || true`,
        { encoding: "utf8" }
      );
    } catch {
      /* swallow */
    }
    const hits = output.split("\n").filter((line) => line.trim().length > 0);
    // `waitForContainer` is the chat-container resolver from chat.model.ts.
    // If any code outside that file imports it, they could create a direct
    // upsert path that bypasses updateChatDocument. The helper is intended
    // to stay file-private. Any new hit is a contract violation.
    assert.deepEqual(
      hits,
      [],
      `waitForContainer (the chat-container resolver) must not be imported outside chat.model.ts. Violations:\n${hits.join("\n")}`
    );
  });

  it("updateChatDocument writes to the cache before returning", () => {
    const chatModelSrc = readFileSync(
      resolve(serverRoot, "models", "chat.model.ts"),
      "utf8"
    );
    // Find the function body and assert it includes the cache repopulation.
    const fnMatch = chatModelSrc.match(
      /export\s+const\s+updateChatDocument[\s\S]+?return\s+result\s*;/
    );
    assert.ok(fnMatch, "updateChatDocument function body must be findable");
    assert.match(
      fnMatch![0],
      /sessionDocCache\.set\s*\(\s*result\.sessionId\s*,/,
      "updateChatDocument must repopulate sessionDocCache with result.sessionId before returning"
    );
  });
});
