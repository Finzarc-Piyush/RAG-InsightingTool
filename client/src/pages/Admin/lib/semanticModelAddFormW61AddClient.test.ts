/**
 * Wave W61-add-client · pure-helper tests for the per-kind Add-entry
 * modal on the admin semantic-model viewer.
 *
 * Covers:
 *   - `validateName` (new in this wave) — snake_case regex, length
 *     bounds matching the server's `semanticMetricSchema.name`.
 *   - `buildAddHeadline` — per-kind noun in the title.
 *   - `buildAddSubmitLabel` — per-kind verb + in-flight ellipsis.
 *   - `formatNameCollisionError` — quoted name, anchor copy.
 *   - `parseHierarchyLevels` — newline split, trim, drop-empty.
 *
 * Pure-helper tests run under `node --test` without jsdom; the modal
 * component (`AddEntryForm.tsx`) is exercised at the type-checker
 * level only (a future Playwright smoke can verify the rendered DOM).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateName } from "./semanticModelEditValidation.js";
import {
  buildAddHeadline,
  buildAddSubmitLabel,
  formatNameCollisionError,
  parseHierarchyLevels,
} from "./semanticModelAddForm.js";

// ─── validateName ─────────────────────────────────────────────────────

test("W61-add-client · validateName: accepts a simple snake_case identifier", () => {
  assert.equal(validateName("revenue"), null);
});

test("W61-add-client · validateName: accepts snake_case with digits and underscores", () => {
  assert.equal(validateName("monthly_active_users_2024"), null);
  assert.equal(validateName("ratio_a_to_b"), null);
});

test("W61-add-client · validateName: rejects PascalCase", () => {
  const err = validateName("MonthlyActiveUsers");
  assert.ok(err, "expected a non-null error");
  assert.ok(
    err.includes("snake_case"),
    `error should mention snake_case but got: ${err}`,
  );
});

test("W61-add-client · validateName: rejects leading digit", () => {
  const err = validateName("2024_revenue");
  assert.ok(err, "expected a non-null error");
  assert.ok(
    err.includes("snake_case") || err.includes("letter"),
    `error should explain the leading-letter rule but got: ${err}`,
  );
});

test("W61-add-client · validateName: rejects spaces or dashes", () => {
  assert.ok(validateName("monthly active users"));
  assert.ok(validateName("monthly-active-users"));
});

test("W61-add-client · validateName: rejects empty / whitespace-only", () => {
  const err = validateName("   ");
  assert.ok(err);
  assert.ok(
    err.includes("required"),
    `empty-input error should mention 'required' but got: ${err}`,
  );
});

test("W61-add-client · validateName: rejects names over 80 characters", () => {
  const longName = "a".repeat(81);
  const err = validateName(longName);
  assert.ok(err);
  assert.ok(
    err.includes("80"),
    `over-length error should mention the 80-char bound but got: ${err}`,
  );
});

test("W61-add-client · validateName: accepts the 80-character boundary", () => {
  const boundary = "a".repeat(80);
  assert.equal(validateName(boundary), null);
});

test("W61-add-client · validateName: accepts the 1-character boundary", () => {
  assert.equal(validateName("x"), null);
});

// ─── buildAddHeadline ────────────────────────────────────────────────

test("W61-add-client · buildAddHeadline: metric noun", () => {
  assert.equal(buildAddHeadline("metric"), "Add a new metric");
});

test("W61-add-client · buildAddHeadline: dimension noun", () => {
  assert.equal(buildAddHeadline("dimension"), "Add a new dimension");
});

test("W61-add-client · buildAddHeadline: hierarchy noun", () => {
  assert.equal(buildAddHeadline("hierarchy"), "Add a new hierarchy");
});

// ─── buildAddSubmitLabel ─────────────────────────────────────────────

test("W61-add-client · buildAddSubmitLabel: idle metric → 'Add metric'", () => {
  assert.equal(buildAddSubmitLabel("metric", false), "Add metric");
});

test("W61-add-client · buildAddSubmitLabel: submitting metric → 'Adding metric…'", () => {
  // Trailing character is Unicode horizontal ellipsis U+2026, NOT three dots.
  assert.equal(buildAddSubmitLabel("metric", true), "Adding metric…");
});

test("W61-add-client · buildAddSubmitLabel: each kind has its own noun", () => {
  assert.equal(buildAddSubmitLabel("dimension", false), "Add dimension");
  assert.equal(buildAddSubmitLabel("hierarchy", true), "Adding hierarchy…");
});

// ─── formatNameCollisionError ────────────────────────────────────────

test("W61-add-client · formatNameCollisionError: quotes the name + names the kind", () => {
  const msg = formatNameCollisionError("metric", "alpha");
  assert.ok(msg.includes(`metric named "alpha"`));
});

test("W61-add-client · formatNameCollisionError: scopes the collision to 'this session'", () => {
  const msg = formatNameCollisionError("dimension", "region");
  assert.ok(
    msg.includes("in this session"),
    `should scope namespace to the session but got: ${msg}`,
  );
});

test("W61-add-client · formatNameCollisionError: ends with the 'Choose a different name.' anchor copy", () => {
  // Pin the anchor so a future shorter rewrite is forced through tests.
  const msg = formatNameCollisionError("hierarchy", "geo");
  assert.ok(
    msg.endsWith("Choose a different name."),
    `anchor copy missing but got: ${msg}`,
  );
});

// ─── parseHierarchyLevels ────────────────────────────────────────────

test("W61-add-client · parseHierarchyLevels: splits on newline + trims", () => {
  assert.deepEqual(parseHierarchyLevels("country\nregion\ncity"), [
    "country",
    "region",
    "city",
  ]);
});

test("W61-add-client · parseHierarchyLevels: drops empty lines and leading/trailing whitespace per line", () => {
  assert.deepEqual(
    parseHierarchyLevels("\n country \n\n  region\n  \ncity\n"),
    ["country", "region", "city"],
  );
});

test("W61-add-client · parseHierarchyLevels: single-line input parses to a one-element array", () => {
  assert.deepEqual(parseHierarchyLevels("region"), ["region"]);
});

test("W61-add-client · parseHierarchyLevels: empty input parses to an empty array", () => {
  assert.deepEqual(parseHierarchyLevels(""), []);
  assert.deepEqual(parseHierarchyLevels("\n\n  \n"), []);
});

test("W61-add-client · parseHierarchyLevels: tolerates \\r\\n line endings (Windows clipboard paste)", () => {
  assert.deepEqual(parseHierarchyLevels("a\r\nb\r\nc"), ["a", "b", "c"]);
});
