/**
 * Wave W61-hierarchy-edit · pure-function tests for the
 * `SemanticHierarchy.levels` editor helpers. Pairs with
 * [`HierarchyEditor.tsx`](../components/HierarchyEditor.tsx) — the
 * component owns the modal UI state (open / draft levels / per-row
 * inputs) while these helpers are exercised by the modal at every
 * keystroke (per-level validation) + every reorder/add/remove
 * (mutation), so pinning them in isolation lets the component stay
 * small and untested-via-mount.
 *
 * All helpers are pure; no DOM / fetch / React; node:test pins the
 * contract directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateLevelName,
  validateLevels,
  moveLevelUp,
  moveLevelDown,
  removeLevel,
  appendLevel,
  setLevelAt,
  buildHierarchyEditHeadline,
  buildHierarchyEditSubmitLabel,
  SNAKE_CASE_LEVEL_RE,
  MAX_LEVEL_NAME_LENGTH,
  MIN_LEVELS,
  MAX_LEVELS,
} from "./semanticModelHierarchyLevels.js";

// ─── Constants ───────────────────────────────────────────────────────

test("W61-hierarchy-edit · constants: MIN_LEVELS = 2 (mirrors server semanticHierarchySchema.levels.min(2))", () => {
  assert.equal(MIN_LEVELS, 2);
});

test("W61-hierarchy-edit · constants: MAX_LEVELS = 8 (mirrors server semanticHierarchySchema.levels.max(8))", () => {
  assert.equal(MAX_LEVELS, 8);
});

test("W61-hierarchy-edit · constants: MAX_LEVEL_NAME_LENGTH = 80 (mirrors server max(80))", () => {
  assert.equal(MAX_LEVEL_NAME_LENGTH, 80);
});

test("W61-hierarchy-edit · constants: SNAKE_CASE_LEVEL_RE matches server's snake_case regex", () => {
  // Server regex: /^[a-z][a-z0-9_]*$/
  assert.equal(SNAKE_CASE_LEVEL_RE.source, "^[a-z][a-z0-9_]*$");
});

// ─── validateLevelName ───────────────────────────────────────────────

test("W61-hierarchy-edit · validateLevelName: returns null on valid snake_case", () => {
  assert.equal(validateLevelName("region"), null);
  assert.equal(validateLevelName("region_name"), null);
  assert.equal(validateLevelName("region123"), null);
});

test("W61-hierarchy-edit · validateLevelName: rejects PascalCase", () => {
  const err = validateLevelName("Region");
  assert.ok(err && err.includes("snake_case"));
});

test("W61-hierarchy-edit · validateLevelName: rejects camelCase", () => {
  const err = validateLevelName("regionName");
  assert.ok(err && err.includes("snake_case"));
});

test("W61-hierarchy-edit · validateLevelName: rejects leading digit", () => {
  const err = validateLevelName("2region");
  assert.ok(err && err.includes("snake_case"));
});

test("W61-hierarchy-edit · validateLevelName: rejects empty string", () => {
  assert.equal(validateLevelName(""), "Level name is required");
});

test("W61-hierarchy-edit · validateLevelName: rejects whitespace-only string", () => {
  assert.equal(validateLevelName("   "), "Level name is required");
});

test("W61-hierarchy-edit · validateLevelName: rejects spaces / dashes", () => {
  assert.ok(validateLevelName("region name")?.includes("snake_case"));
  assert.ok(validateLevelName("region-name")?.includes("snake_case"));
});

test("W61-hierarchy-edit · validateLevelName: rejects over-80-character names", () => {
  const long = "a".repeat(81);
  const err = validateLevelName(long);
  assert.ok(err && err.includes("80 characters or fewer"));
});

test("W61-hierarchy-edit · validateLevelName: accepts 80-character boundary", () => {
  const exactly80 = "a".repeat(80);
  assert.equal(validateLevelName(exactly80), null);
});

test("W61-hierarchy-edit · validateLevelName: accepts single-character snake_case", () => {
  assert.equal(validateLevelName("r"), null);
});

// ─── validateLevels (cross-level) ────────────────────────────────────

test("W61-hierarchy-edit · validateLevels: valid for 2 distinct snake_case levels", () => {
  const result = validateLevels(["region", "country"]);
  assert.equal(result.valid, true);
  assert.equal(result.global, null);
  assert.deepEqual(result.perLevel, [null, null]);
});

test("W61-hierarchy-edit · validateLevels: surfaces 'must have at least 2 levels' on a single-level array", () => {
  const result = validateLevels(["region"]);
  assert.equal(result.valid, false);
  assert.equal(result.global, "Hierarchy must have at least 2 levels");
});

test("W61-hierarchy-edit · validateLevels: surfaces 'must have at least 2 levels' on an empty array", () => {
  const result = validateLevels([]);
  assert.equal(result.valid, false);
  assert.equal(result.global, "Hierarchy must have at least 2 levels");
});

test("W61-hierarchy-edit · validateLevels: surfaces 'must have at most 8 levels' on a 9-level array", () => {
  const result = validateLevels([
    "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9",
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.global, "Hierarchy must have at most 8 levels");
});

test("W61-hierarchy-edit · validateLevels: 8 levels accepted at the upper boundary", () => {
  const result = validateLevels([
    "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8",
  ]);
  assert.equal(result.valid, true);
});

test("W61-hierarchy-edit · validateLevels: per-level errors surface alongside global ones", () => {
  // 9 levels (over max) AND one is PascalCase. Both errors should
  // surface — the modal renders them in different places.
  const result = validateLevels([
    "l1", "Bad", "l3", "l4", "l5", "l6", "l7", "l8", "l9",
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.global?.includes("at most 8 levels"));
  assert.equal(result.perLevel[1]?.includes("snake_case"), true);
});

test("W61-hierarchy-edit · validateLevels: duplicate level surfaces an inline error on BOTH duplicate positions", () => {
  // The user can't tell which one is "the duplicate" — both inputs
  // need a marker so they self-correct (either rename one or remove
  // the other).
  const result = validateLevels(["region", "country", "region"]);
  assert.equal(result.valid, false);
  assert.equal(result.global, null);
  assert.equal(result.perLevel[0], "Duplicate level — already in this hierarchy");
  assert.equal(result.perLevel[1], null, "non-dupe stays null");
  assert.equal(result.perLevel[2], "Duplicate level — already in this hierarchy");
});

test("W61-hierarchy-edit · validateLevels: duplicate-detection does NOT override a per-level format error (format wins for clarity)", () => {
  // Both positions are "Bad" (PascalCase + duplicate). The per-level
  // format error wins because it's more actionable — the admin needs
  // to rename to snake_case, after which the duplicate (if still
  // present) becomes the next signal.
  const result = validateLevels(["Bad", "Bad"]);
  assert.equal(result.valid, false);
  assert.ok(result.perLevel[0]?.includes("snake_case"));
  assert.ok(result.perLevel[1]?.includes("snake_case"));
});

// ─── moveLevelUp ─────────────────────────────────────────────────────

test("W61-hierarchy-edit · moveLevelUp: swaps idx with idx-1 (returns fresh array)", () => {
  const orig = ["a", "b", "c"];
  const next = moveLevelUp(orig, 2);
  assert.deepEqual(next, ["a", "c", "b"]);
  assert.notEqual(next, orig, "returns a fresh array, not the original");
});

test("W61-hierarchy-edit · moveLevelUp: no-op (returns copy) when idx is 0", () => {
  const orig = ["a", "b", "c"];
  const next = moveLevelUp(orig, 0);
  assert.deepEqual(next, ["a", "b", "c"]);
  assert.notEqual(next, orig);
});

test("W61-hierarchy-edit · moveLevelUp: no-op when idx is out of range", () => {
  assert.deepEqual(moveLevelUp(["a", "b"], 5), ["a", "b"]);
  assert.deepEqual(moveLevelUp(["a", "b"], -1), ["a", "b"]);
});

// ─── moveLevelDown ───────────────────────────────────────────────────

test("W61-hierarchy-edit · moveLevelDown: swaps idx with idx+1 (returns fresh array)", () => {
  const orig = ["a", "b", "c"];
  const next = moveLevelDown(orig, 0);
  assert.deepEqual(next, ["b", "a", "c"]);
  assert.notEqual(next, orig);
});

test("W61-hierarchy-edit · moveLevelDown: no-op (returns copy) when idx is at last position", () => {
  const orig = ["a", "b", "c"];
  const next = moveLevelDown(orig, 2);
  assert.deepEqual(next, ["a", "b", "c"]);
  assert.notEqual(next, orig);
});

test("W61-hierarchy-edit · moveLevelDown: no-op when idx is out of range", () => {
  assert.deepEqual(moveLevelDown(["a", "b"], 5), ["a", "b"]);
  assert.deepEqual(moveLevelDown(["a", "b"], -1), ["a", "b"]);
});

// ─── removeLevel ─────────────────────────────────────────────────────

test("W61-hierarchy-edit · removeLevel: drops the level at idx", () => {
  assert.deepEqual(removeLevel(["a", "b", "c"], 1), ["a", "c"]);
});

test("W61-hierarchy-edit · removeLevel: drops first level when idx=0", () => {
  assert.deepEqual(removeLevel(["a", "b", "c"], 0), ["b", "c"]);
});

test("W61-hierarchy-edit · removeLevel: drops last level when idx=length-1", () => {
  assert.deepEqual(removeLevel(["a", "b", "c"], 2), ["a", "b"]);
});

test("W61-hierarchy-edit · removeLevel: no-op on out-of-range idx", () => {
  assert.deepEqual(removeLevel(["a", "b"], 5), ["a", "b"]);
  assert.deepEqual(removeLevel(["a", "b"], -1), ["a", "b"]);
});

// ─── appendLevel ─────────────────────────────────────────────────────

test("W61-hierarchy-edit · appendLevel: adds the new level to the end", () => {
  assert.deepEqual(appendLevel(["a", "b"], "c"), ["a", "b", "c"]);
});

test("W61-hierarchy-edit · appendLevel: works on an empty array (caller's responsibility to validate count bounds)", () => {
  assert.deepEqual(appendLevel([], "a"), ["a"]);
});

test("W61-hierarchy-edit · appendLevel: passes the raw string through unchanged (caller validates first)", () => {
  // The helper doesn't validate — that's the caller's job (the modal
  // runs validateLevelName at append time and refuses if invalid).
  // This keeps the helper composable; the modal can also use it for
  // restoring undo state without re-validating.
  assert.deepEqual(appendLevel(["a"], "Invalid PascalCase"), [
    "a",
    "Invalid PascalCase",
  ]);
});

// ─── setLevelAt ──────────────────────────────────────────────────────

test("W61-hierarchy-edit · setLevelAt: replaces the level at idx", () => {
  assert.deepEqual(setLevelAt(["a", "b", "c"], 1, "z"), ["a", "z", "c"]);
});

test("W61-hierarchy-edit · setLevelAt: no-op on out-of-range idx", () => {
  assert.deepEqual(setLevelAt(["a", "b"], 5, "z"), ["a", "b"]);
});

test("W61-hierarchy-edit · setLevelAt: returns a fresh array (no in-place mutation)", () => {
  const orig = ["a", "b"];
  const next = setLevelAt(orig, 0, "z");
  assert.deepEqual(next, ["z", "b"]);
  assert.deepEqual(orig, ["a", "b"], "original untouched");
});

// ─── Headline + submit label builders ────────────────────────────────

test("W61-hierarchy-edit · buildHierarchyEditHeadline: uses the human-readable label, not the snake_case name", () => {
  assert.equal(
    buildHierarchyEditHeadline("Geographic hierarchy"),
    "Edit levels for Geographic hierarchy",
  );
});

test("W61-hierarchy-edit · buildHierarchyEditSubmitLabel: idle / submitting pair with U+2026 ellipsis", () => {
  assert.equal(buildHierarchyEditSubmitLabel(false), "Save levels");
  assert.equal(buildHierarchyEditSubmitLabel(true), "Saving…");
  // Pin the actual U+2026 ellipsis character — a future regression
  // that replaces it with three ASCII dots would change the
  // appearance and the helper-test pin would catch it.
  assert.ok(
    buildHierarchyEditSubmitLabel(true).includes("…"),
    "submitting label must use U+2026 ellipsis (\\u2026)",
  );
});

// ─── Mutation helpers are immutable (no in-place mutation) ───────────

test("W61-hierarchy-edit · all mutation helpers leave the input array untouched", () => {
  const orig = ["a", "b", "c", "d"];
  moveLevelUp(orig, 1);
  moveLevelDown(orig, 1);
  removeLevel(orig, 1);
  appendLevel(orig, "z");
  setLevelAt(orig, 1, "z");
  assert.deepEqual(orig, ["a", "b", "c", "d"], "original array untouched");
});

// ─── Round-trip composability ────────────────────────────────────────

test("W61-hierarchy-edit · moveLevelUp followed by moveLevelDown at the new position restores the original", () => {
  const orig = ["a", "b", "c", "d"];
  const moved = moveLevelUp(orig, 2);
  const restored = moveLevelDown(moved, 1);
  assert.deepEqual(restored, orig);
});

test("W61-hierarchy-edit · appendLevel followed by removeLevel at the last position restores the original", () => {
  const orig = ["a", "b"];
  const added = appendLevel(orig, "c");
  const restored = removeLevel(added, added.length - 1);
  assert.deepEqual(restored, orig);
});
