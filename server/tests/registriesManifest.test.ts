/**
 * Wave CS3 · Static-extraction sanity for the registry manifest generator.
 * Fast parse over the live tree; glob-discovered by runTests.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTools, extractRoutes, extractSkills } from "../scripts/generate-registries.js";

test("tools: extracts the full registry with no duplicate names", () => {
  const { tools, duplicates } = extractTools();
  assert.equal(duplicates.length, 0, `duplicate tool names (fatal at boot, invariant #8): ${duplicates.join(", ")}`);
  assert.ok(tools.length >= 28, `expected ~31 tools, got ${tools.length}`);
  const names = new Set(tools.map((t) => t.name));
  for (const expected of ["build_chart", "run_correlation", "web_search", "run_budget_optimizer", "execute_query_plan"]) {
    assert.ok(names.has(expected), `missing known tool: ${expected}`);
  }
});

test("routes: mounts resolve to handler lists with composed paths", () => {
  const groups = extractRoutes();
  assert.ok(groups.length >= 15, `expected ~19 route modules, got ${groups.length}`);
  const total = groups.reduce((s, g) => s + g.handlers.length, 0);
  assert.ok(total >= 100, `expected ~129 handlers, got ${total}`);
  assert.ok(groups.every((g) => g.handlers.every((h) => h.path.startsWith("/api"))), "every path should start at its /api mount");
});

test("skills: five self-registering modules with resolved names", () => {
  const skills = extractSkills();
  assert.equal(skills.length, 5, `expected 5 skills, got ${skills.length}`);
  assert.ok(skills.every((s) => !/\.ts$/.test(s.name) && s.name.length > 0), "skill names should resolve, not fall back to filename");
});
