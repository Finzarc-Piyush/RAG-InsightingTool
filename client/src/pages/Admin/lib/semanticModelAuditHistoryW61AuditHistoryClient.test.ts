/**
 * Wave W61-audit-history-client · pure formatter / summary tests for
 * the upcoming W61-audit-history-tab UI.
 *
 * Covers `formatAuditTimestamp` (UTC stability, zero-padding, edge dates),
 * `buildAuditEntrySummary` (newest-first index → 1-based save number,
 * subhead content anchors), and `buildRevertConfirmation` (matches the
 * row label, includes the version + savedBy anchors).
 *
 * No jsdom — every helper is string-in / string-out so node:test runs
 * native without a window mock. Mirrors the W61-source-badge /
 * W61-source-filter / W61-filter-persist test-style precedent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatAuditTimestamp,
  buildAuditEntrySummary,
  buildRevertConfirmation,
} from "./semanticModelAuditHistory";
import type { AdminSemanticModelAuditEntry } from "@/lib/api/admin";

function makeEntry(
  overrides: Partial<AdminSemanticModelAuditEntry> = {},
): AdminSemanticModelAuditEntry {
  return {
    savedAt: Date.UTC(2026, 4, 20, 14, 23, 0), // 2026-05-20 14:23 UTC
    savedBy: "alice@example.com",
    priorVersion: 3,
    priorModel: {
      version: 3,
      name: "Sales model",
      metrics: [],
      dimensions: [],
      hierarchies: [],
    } as AdminSemanticModelAuditEntry["priorModel"],
    ...overrides,
  };
}

// ─── formatAuditTimestamp ────────────────────────────────────────────

test("W61-audit-history-client · formatAuditTimestamp: produces YYYY-MM-DD HH:MM UTC", () => {
  const ts = Date.UTC(2026, 4, 20, 14, 23, 45); // May 20, 2026 14:23:45 UTC
  assert.equal(formatAuditTimestamp(ts), "2026-05-20 14:23 UTC");
});

test("W61-audit-history-client · formatAuditTimestamp: zero-pads single-digit month/day/hour/minute", () => {
  const ts = Date.UTC(2026, 0, 5, 7, 9, 0); // Jan 5, 2026 07:09:00 UTC
  assert.equal(formatAuditTimestamp(ts), "2026-01-05 07:09 UTC");
});

test("W61-audit-history-client · formatAuditTimestamp: midnight + new-year-eve edges", () => {
  const midnight = Date.UTC(2026, 11, 31, 0, 0, 0);
  assert.equal(formatAuditTimestamp(midnight), "2026-12-31 00:00 UTC");
  const oneMinBeforeMidnight = Date.UTC(2026, 11, 31, 23, 59, 0);
  assert.equal(
    formatAuditTimestamp(oneMinBeforeMidnight),
    "2026-12-31 23:59 UTC",
  );
});

test("W61-audit-history-client · formatAuditTimestamp: epoch 0 produces the Unix epoch start", () => {
  // Sanity pin against a future refactor that might add locale-specific
  // formatting and accidentally drift to local TZ at the boundaries.
  assert.equal(formatAuditTimestamp(0), "1970-01-01 00:00 UTC");
});

test("W61-audit-history-client · formatAuditTimestamp: never includes commas, T-separators, or seconds", () => {
  // Pins format stability — a future bump to a `toISOString()`-based
  // implementation would silently flip to `2026-05-20T14:23:45.000Z`
  // and break the audit-log row's visual rhythm.
  const out = formatAuditTimestamp(Date.UTC(2026, 4, 20, 14, 23, 45));
  assert.ok(!out.includes(","), "no commas");
  // ISO 8601 puts a literal `T` between the date and time (e.g.
  // `2026-05-20T14:23`); the UTC suffix is a separate concern.
  assert.ok(!/\dT\d/.test(out), "no ISO T separator between date and time");
  assert.ok(!out.includes(":45"), "no seconds component");
  assert.ok(out.endsWith(" UTC"), "UTC suffix preserved");
});

// ─── buildAuditEntrySummary ──────────────────────────────────────────

test("W61-audit-history-client · buildAuditEntrySummary: newest-first index 0 with total 5 → 'Save 5 of 5'", () => {
  // The buffer is newest-first; the most recent entry is `Save M of M`
  // (the count is the highest because the most recent save was the
  // most recent action). Walking back through indices: index 1 → Save M-1
  // of M, etc., down to index M-1 → Save 1 of M.
  const entry = makeEntry({ priorVersion: 5 });
  const { headline, subhead } = buildAuditEntrySummary(entry, 0, 5);
  assert.equal(headline, "Save 5 of 5");
  assert.ok(subhead.includes("alice@example.com"));
  assert.ok(subhead.includes("2026-05-20 14:23 UTC"));
  assert.ok(subhead.includes("was v5"));
});

test("W61-audit-history-client · buildAuditEntrySummary: walks back across indices", () => {
  // Pin the full mapping for a 5-entry buffer:
  // - index 0 → "Save 5 of 5" (newest)
  // - index 4 → "Save 1 of 5" (oldest)
  const entry = makeEntry();
  for (let i = 0; i < 5; i++) {
    const expected = `Save ${5 - i} of 5`;
    assert.equal(buildAuditEntrySummary(entry, i, 5).headline, expected);
  }
});

test("W61-audit-history-client · buildAuditEntrySummary: single-entry buffer reads 'Save 1 of 1'", () => {
  const { headline } = buildAuditEntrySummary(makeEntry(), 0, 1);
  assert.equal(headline, "Save 1 of 1");
});

test("W61-audit-history-client · buildAuditEntrySummary: full-cap buffer of 10", () => {
  const entry = makeEntry();
  assert.equal(
    buildAuditEntrySummary(entry, 0, 10).headline,
    "Save 10 of 10",
    "newest position at cap",
  );
  assert.equal(
    buildAuditEntrySummary(entry, 9, 10).headline,
    "Save 1 of 10",
    "oldest position at cap",
  );
});

test("W61-audit-history-client · buildAuditEntrySummary: subhead uses the dot separator consistently", () => {
  // Pin the visual rhythm — three fields joined by ` · ` (spaced
  // middle-dot) so the JSX doesn't need to re-derive the layout.
  const entry = makeEntry({ savedBy: "bob@example.com", priorVersion: 7 });
  const { subhead } = buildAuditEntrySummary(entry, 0, 3);
  assert.equal(subhead.split(" · ").length, 3);
  assert.equal(
    subhead,
    "bob@example.com · 2026-05-20 14:23 UTC · was v7",
  );
});

test("W61-audit-history-client · buildAuditEntrySummary: handles 'unknown' savedBy (server fallback)", () => {
  // The server stamps `"unknown"` when getAuthenticatedEmail returns null.
  // The summary shouldn't munge that value — admins should see the raw
  // attribution-failure marker so they know something wasn't recorded.
  const { subhead } = buildAuditEntrySummary(
    makeEntry({ savedBy: "unknown" }),
    0,
    1,
  );
  assert.ok(subhead.startsWith("unknown · "));
});

// ─── buildRevertConfirmation ─────────────────────────────────────────

test("W61-audit-history-client · buildRevertConfirmation: includes save-number matching the summary's headline", () => {
  const entry = makeEntry({ priorVersion: 3 });
  const prompt = buildRevertConfirmation(entry, 2, 5);
  // index 2 in a 5-entry buffer → Save 3 (since 5 - 2 = 3)
  assert.ok(prompt.includes("Save 3 of 5"));
});

test("W61-audit-history-client · buildRevertConfirmation: anchors on priorVersion + savedBy", () => {
  const entry = makeEntry({ savedBy: "carol@example.com", priorVersion: 9 });
  const prompt = buildRevertConfirmation(entry, 0, 1);
  assert.ok(prompt.includes("v9"));
  assert.ok(prompt.includes("carol@example.com"));
});

test("W61-audit-history-client · buildRevertConfirmation: warns that the current model will be saved first", () => {
  // Load-bearing for the "undo this revert works" semantic — the
  // prompt should set the admin's expectation that the revert is
  // itself reversible.
  const prompt = buildRevertConfirmation(makeEntry(), 0, 1);
  assert.ok(
    prompt.toLowerCase().includes("saved to the audit log"),
    "prompt mentions the audit-log write",
  );
  assert.ok(
    prompt.toLowerCase().includes("undone"),
    "prompt mentions that the revert can be undone",
  );
});

test("W61-audit-history-client · buildRevertConfirmation: paragraph break separates the action from the consequence note", () => {
  // The `window.confirm()` dialog renders `\n\n` as a paragraph break
  // in every modern browser; a single line of dense text would be
  // harder to scan before clicking.
  const prompt = buildRevertConfirmation(makeEntry(), 0, 1);
  assert.ok(prompt.includes("\n\n"));
});
