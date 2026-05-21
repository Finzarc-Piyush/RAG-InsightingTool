/**
 * Wave W61-delete-client · pure formatter tests for the delete
 * confirmation modal helpers.
 *
 * Covers `buildDeleteHeadline` (kind / name interpolation, trailing
 * `?` invariant), `buildDeleteGenericConfirmation` (kind + name + the
 * audit-log reassurance copy), and `buildDeleteReferencesWarning`
 * (singular / plural correctness at the 0 / 1 / N boundaries plus the
 * subhead suppression when `totalOccurrences === chartCount`).
 *
 * No jsdom — every helper is string-in / string-out so `node:test`
 * runs native without a window mock. Mirrors the
 * W61-audit-history-client / W61-source-filter / W61-filter-persist
 * test-style precedent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDeleteHeadline,
  buildDeleteGenericConfirmation,
  buildDeleteReferencesWarning,
  DELETE_AUDIT_LOG_REASSURANCE,
} from "./semanticModelDeleteConfirmation";

// ─── buildDeleteHeadline ─────────────────────────────────────────────

test('W61-delete-client · buildDeleteHeadline: metric · returns `Delete metric "<name>"?`', () => {
  assert.equal(
    buildDeleteHeadline("metric", "revenue"),
    'Delete metric "revenue"?',
  );
});

test('W61-delete-client · buildDeleteHeadline: dimension · returns `Delete dimension "<name>"?`', () => {
  assert.equal(
    buildDeleteHeadline("dimension", "region"),
    'Delete dimension "region"?',
  );
});

test('W61-delete-client · buildDeleteHeadline: hierarchy · returns `Delete hierarchy "<name>"?`', () => {
  assert.equal(
    buildDeleteHeadline("hierarchy", "geo_drill"),
    'Delete hierarchy "geo_drill"?',
  );
});

test("W61-delete-client · buildDeleteHeadline: preserves snake_case names byte-exact", () => {
  // The entry name is a SQL-ish identifier; if a future refactor
  // lower-cased / camel-cased the name in the headline, the admin
  // would see a different name than the one they're about to delete.
  assert.equal(
    buildDeleteHeadline("metric", "gross_margin_pct"),
    'Delete metric "gross_margin_pct"?',
  );
});

test("W61-delete-client · buildDeleteHeadline: every headline ends with a `?`", () => {
  // Pins the question-form invariant — the title is a question to the
  // admin, not an imperative; flipping it to `"Confirm delete"` would
  // change the modal's interaction expectation.
  const headlines = [
    buildDeleteHeadline("metric", "x"),
    buildDeleteHeadline("dimension", "y"),
    buildDeleteHeadline("hierarchy", "z"),
  ];
  for (const h of headlines) {
    assert.ok(h.endsWith("?"), `expected headline to end with ?: ${h}`);
  }
});

// ─── buildDeleteGenericConfirmation ──────────────────────────────────

test('W61-delete-client · buildDeleteGenericConfirmation: metric · "No charts reference …"', () => {
  const body = buildDeleteGenericConfirmation("metric", "revenue");
  assert.ok(
    body.includes('No charts reference metric "revenue"'),
    `expected the metric phrasing in: ${body}`,
  );
});

test("W61-delete-client · buildDeleteGenericConfirmation: includes the audit-log reassurance", () => {
  const body = buildDeleteGenericConfirmation("dimension", "region");
  assert.ok(
    body.includes(DELETE_AUDIT_LOG_REASSURANCE),
    `expected the audit-log reassurance to be embedded in: ${body}`,
  );
});

test("W61-delete-client · buildDeleteGenericConfirmation: hierarchy noun reads correctly", () => {
  const body = buildDeleteGenericConfirmation("hierarchy", "geo_drill");
  assert.ok(
    body.includes('No charts reference hierarchy "geo_drill"'),
    `expected the hierarchy phrasing in: ${body}`,
  );
});

// ─── buildDeleteReferencesWarning ────────────────────────────────────

test("W61-delete-client · buildDeleteReferencesWarning: 0 charts · returns null", () => {
  assert.equal(buildDeleteReferencesWarning("metric", 0, 0), null);
});

test("W61-delete-client · buildDeleteReferencesWarning: negative chartCount · returns null (defense)", () => {
  // Defensive pin against a future bug where a malformed server
  // response sends a negative count — the modal should render the
  // generic confirmation rather than a nonsense "Removing this
  // metric will break -2 charts" sentence.
  assert.equal(buildDeleteReferencesWarning("metric", -1, 0), null);
});

test("W61-delete-client · buildDeleteReferencesWarning: 1 chart · singular phrasing", () => {
  const warning = buildDeleteReferencesWarning("metric", 1, 1);
  assert.ok(warning, "expected a non-null warning");
  // "1 chart that references it" — singular noun + the third-person
  // singular verb form.
  assert.ok(
    warning.headline.includes("1 chart that references it"),
    `expected singular phrasing: ${warning.headline}`,
  );
  // No subhead because totalOccurrences === chartCount.
  assert.equal(warning.subhead, undefined);
});

test("W61-delete-client · buildDeleteReferencesWarning: 3 charts equal occurrences · plural, no subhead", () => {
  const warning = buildDeleteReferencesWarning("metric", 3, 3);
  assert.ok(warning, "expected a non-null warning");
  // "3 charts that reference it" — plural noun + bare-form verb.
  assert.ok(
    warning.headline.includes("3 charts that reference it"),
    `expected plural phrasing: ${warning.headline}`,
  );
  assert.equal(warning.subhead, undefined);
});

test("W61-delete-client · buildDeleteReferencesWarning: 3 charts · 4 occurrences · plural with subhead", () => {
  const warning = buildDeleteReferencesWarning("dimension", 3, 4);
  assert.ok(warning, "expected a non-null warning");
  assert.ok(
    warning.headline.includes("3 charts that reference it"),
    `expected plural phrasing: ${warning.headline}`,
  );
  assert.ok(warning.subhead !== undefined, "expected a subhead");
  assert.ok(
    warning.subhead.includes("4 references total"),
    `expected total-occurrences subhead: ${warning.subhead}`,
  );
});

test("W61-delete-client · buildDeleteReferencesWarning: 1 chart · 2 occurrences · singular chart + plural references", () => {
  // The "heavy usage in one chart" branch: 1 chart with multiple
  // field positions inside it. Chart noun is singular; references
  // noun is plural.
  const warning = buildDeleteReferencesWarning("metric", 1, 2);
  assert.ok(warning, "expected a non-null warning");
  assert.ok(
    warning.headline.includes("1 chart that references it"),
    `expected singular chart noun: ${warning.headline}`,
  );
  assert.ok(warning.subhead !== undefined, "expected a subhead");
  assert.ok(
    warning.subhead.includes("2 references total"),
    `expected plural references in subhead: ${warning.subhead}`,
  );
});

test("W61-delete-client · buildDeleteReferencesWarning: hierarchy noun reads correctly", () => {
  const warning = buildDeleteReferencesWarning("hierarchy", 2, 2);
  assert.ok(warning, "expected a non-null warning");
  assert.ok(
    warning.headline.includes("Removing this hierarchy"),
    `expected the hierarchy noun: ${warning.headline}`,
  );
});

test("W61-delete-client · buildDeleteReferencesWarning: non-null warnings never include the literal `0`", () => {
  // Sanity pin: the function returns `null` for chartCount === 0, so
  // any other branch should never produce a "break 0 charts" sentence.
  // A future refactor that accidentally broadcasts the zero path into
  // the warning string would surface here.
  const cases: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [1, 2],
    [3, 3],
    [3, 4],
    [10, 25],
  ];
  for (const [charts, occ] of cases) {
    const warning = buildDeleteReferencesWarning("metric", charts, occ);
    assert.ok(warning, "expected a non-null warning");
    assert.ok(
      !/\b0\s+charts?\b/.test(warning.headline),
      `expected no "0 chart(s)" phrasing: ${warning.headline}`,
    );
  }
});

test("W61-delete-client · DELETE_AUDIT_LOG_REASSURANCE: stable copy with the `audit log` + `revert` anchors", () => {
  // Pin the literal string anchors that the test suite uses as
  // contract: a future copy edit can change the wording but must
  // keep both anchors so the admin reads both `audit log` (the
  // source-of-truth surface) and `revert` (the recovery affordance).
  assert.ok(
    DELETE_AUDIT_LOG_REASSURANCE.includes("audit log"),
    `expected "audit log" anchor in: ${DELETE_AUDIT_LOG_REASSURANCE}`,
  );
  assert.ok(
    DELETE_AUDIT_LOG_REASSURANCE.includes("revert"),
    `expected "revert" anchor in: ${DELETE_AUDIT_LOG_REASSURANCE}`,
  );
});
