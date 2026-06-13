/**
 * Wave CS4 · Sanity for the symbol-index generator. Glob-discovered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectSymbols } from "../scripts/generate-symbols.js";

test("symbol index resolves known exports to their definition file", () => {
  const rows = collectSymbols();
  assert.ok(rows.length > 2000, `expected >2000 exported symbols, got ${rows.length}`);

  const find = (name: string) => rows.find((r) => r.symbol === name);
  assert.equal(find("mutateChatDocument")?.file, "server/models/chat.model.ts");
  assert.equal(find("VERIFIER_VERDICT")?.file, "server/lib/agents/runtime/schemas.ts");
  assert.equal(find("ToolAlreadyRegisteredError")?.kind, "class");
});

test("symbol index excludes test files (the dominant grep noise)", () => {
  const rows = collectSymbols();
  const testRows = rows.filter(
    (r) => r.file.includes("/tests/") || /\.test\.|\.spec\.|\.vitest\./.test(r.file)
  );
  assert.equal(testRows.length, 0, `test-file symbols leaked into the index: ${testRows.slice(0, 3).map((r) => r.file).join(", ")}`);
});
