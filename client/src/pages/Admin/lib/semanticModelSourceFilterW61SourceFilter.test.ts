/**
 * Wave W61-source-filter · coverage of the per-source filter helpers.
 *
 * The chip row UI lives in `AdminSemanticModelDetail.tsx`; these
 * tests pin the pure filter + count + label mappings so:
 *   - a future drift in `SemanticEntrySource` lands as a test failure
 *     (the count function's hard-coded branches would miss a 4th
 *     value silently),
 *   - the `"all"` sentinel always returns the input array unchanged,
 *   - the count semantics stay consistent (sum of per-source counts
 *     equals the `"all"` count).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { SemanticEntrySource } from "./semanticModelSourceBadge.js";
import {
  SOURCE_FILTER_ALL,
  SOURCE_FILTER_ORDER,
  countEntriesBySource,
  filterEntriesBySource,
  getFilterLabel,
  type SemanticEntryFilter,
} from "./semanticModelSourceFilter.js";

interface FixtureEntry {
  name: string;
  source: SemanticEntrySource;
}

const FIXTURE: ReadonlyArray<FixtureEntry> = [
  { name: "a", source: "auto" },
  { name: "b", source: "auto" },
  { name: "c", source: "user" },
  { name: "d", source: "user" },
  { name: "e", source: "user" },
  { name: "f", source: "domain" },
];

test("W61-source-filter · SOURCE_FILTER_ALL is the string 'all'", () => {
  assert.equal(SOURCE_FILTER_ALL, "all");
});

test("W61-source-filter · filterEntriesBySource: 'all' returns the input reference unchanged", () => {
  const out = filterEntriesBySource(FIXTURE, "all");
  // Reference-equality is load-bearing — "all" is the default + most-common
  // case and skipping the allocation matters when an admin has 100+
  // entries per table.
  assert.equal(out, FIXTURE);
});

test("W61-source-filter · filterEntriesBySource: 'auto' returns only auto entries", () => {
  const out = filterEntriesBySource(FIXTURE, "auto");
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e.source === "auto"));
  assert.deepEqual(
    out.map((e) => e.name),
    ["a", "b"],
  );
});

test("W61-source-filter · filterEntriesBySource: 'user' returns only user entries", () => {
  const out = filterEntriesBySource(FIXTURE, "user");
  assert.equal(out.length, 3);
  assert.ok(out.every((e) => e.source === "user"));
});

test("W61-source-filter · filterEntriesBySource: 'domain' returns only domain entries", () => {
  const out = filterEntriesBySource(FIXTURE, "domain");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "f");
});

test("W61-source-filter · filterEntriesBySource: empty input returns empty for every filter", () => {
  for (const f of SOURCE_FILTER_ORDER) {
    assert.deepEqual([...filterEntriesBySource([], f)], []);
  }
});

test("W61-source-filter · filterEntriesBySource: does not mutate input array", () => {
  const arr: FixtureEntry[] = [...FIXTURE];
  const snapshot = arr.map((e) => e.name);
  filterEntriesBySource(arr, "user");
  assert.deepEqual(
    arr.map((e) => e.name),
    snapshot,
  );
});

test("W61-source-filter · filterEntriesBySource: preserves input order within the filtered subset", () => {
  // The chip filter should NOT silently re-order the underlying list
  // (which is alphabetically sorted upstream); filtering by source
  // must preserve the prior ordering or the admin's scroll position
  // would jump to a different entry on filter change.
  const out = filterEntriesBySource(FIXTURE, "user");
  assert.deepEqual(
    out.map((e) => e.name),
    ["c", "d", "e"],
  );
});

test("W61-source-filter · countEntriesBySource: returns 0 for every slot on empty input", () => {
  const counts = countEntriesBySource([]);
  assert.equal(counts.all, 0);
  assert.equal(counts.auto, 0);
  assert.equal(counts.user, 0);
  assert.equal(counts.domain, 0);
});

test("W61-source-filter · countEntriesBySource: matches fixture distribution", () => {
  const counts = countEntriesBySource(FIXTURE);
  assert.equal(counts.all, 6);
  assert.equal(counts.auto, 2);
  assert.equal(counts.user, 3);
  assert.equal(counts.domain, 1);
});

test("W61-source-filter · countEntriesBySource: 'all' count always equals the sum of per-source counts", () => {
  // Load-bearing invariant — if a 4th source value lands, this pin
  // catches the count-function drift before the chip row renders a
  // misleading "All (98)" while the per-source chips sum to 100.
  const counts = countEntriesBySource(FIXTURE);
  assert.equal(counts.all, counts.auto + counts.user + counts.domain);
});

test("W61-source-filter · getFilterLabel: 'all' → 'All'", () => {
  assert.equal(getFilterLabel("all"), "All");
});

test("W61-source-filter · getFilterLabel: source labels match the source-badge capitalisation", () => {
  // Drift check — the chip row visually pairs with the row badges,
  // so a drift between "User" (filter chip) and "user" (row badge)
  // would read as two different labels for the same concept.
  assert.equal(getFilterLabel("auto"), "Auto");
  assert.equal(getFilterLabel("user"), "User");
  assert.equal(getFilterLabel("domain"), "Domain");
});

test("W61-source-filter · SOURCE_FILTER_ORDER: starts with 'all' so the default reads as the leftmost chip", () => {
  assert.equal(SOURCE_FILTER_ORDER[0], "all");
});

test("W61-source-filter · SOURCE_FILTER_ORDER: 'user' leads the source filters (most-common workflow optimisation)", () => {
  // Admin's most common workflow is "show me what I've edited" — the
  // chip row puts User immediately after All so scan-distance is
  // minimised. Alphabetical order would put Auto first, which is the
  // least-clicked filter.
  assert.equal(SOURCE_FILTER_ORDER[1], "user");
});

test("W61-source-filter · SOURCE_FILTER_ORDER: covers exactly the four filter values without duplicates", () => {
  assert.equal(SOURCE_FILTER_ORDER.length, 4);
  assert.equal(new Set(SOURCE_FILTER_ORDER).size, 4);
});

test("W61-source-filter · SOURCE_FILTER_ORDER: every value is a valid SemanticEntryFilter", () => {
  // TypeScript already enforces this via the type annotation, but a
  // runtime assertion catches a future widening that bypasses the
  // type system (e.g. a JSON config defining the order).
  const valid: ReadonlyArray<SemanticEntryFilter> = [
    "all",
    "auto",
    "user",
    "domain",
  ];
  for (const f of SOURCE_FILTER_ORDER) {
    assert.ok(valid.includes(f), `${f} should be a valid filter value`);
  }
});

test("W61-source-filter · filterEntriesBySource: type-narrowed generic preserves the entry's full shape", () => {
  // The generic constraint `T extends { source: SemanticEntrySource }`
  // means a caller can pass `SemanticMetric` and get back `SemanticMetric[]`
  // (not a stripped-to-source-only shape).
  const metrics = [
    { name: "rev", label: "Revenue", source: "user" as const, extra: 42 },
    { name: "cost", label: "Cost", source: "auto" as const, extra: 7 },
  ];
  const filtered = filterEntriesBySource(metrics, "user");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.label, "Revenue");
  assert.equal(filtered[0]!.extra, 42);
});
