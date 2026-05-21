/**
 * Wave W61-per-section-filter · pure-reducer pins for the per-section
 * filter override layered on top of the W61-source-filter global chip
 * row.
 *
 * The reducer + selectors are pure functions over a small typed shape;
 * jsdom isn't needed (the chip-click event source is in the component,
 * and the shift-key bit gets normalised to the `modifier: boolean`
 * arg before it reaches `applyChipClick`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyChipClick,
  getEffectiveFilter,
  hasAnyOverride,
  isSectionOverridden,
  makeSectionFilters,
} from "./semanticModelSectionFilters.js";

// ─────────────────────────── makeSectionFilters ───────────────────────────

test("W61-per-section-filter · makeSectionFilters: seeds global, no overrides", () => {
  const s = makeSectionFilters("user");
  assert.equal(s.global, "user");
  assert.equal(s.overrides.metrics, null);
  assert.equal(s.overrides.dimensions, null);
  assert.equal(s.overrides.hierarchies, null);
});

test("W61-per-section-filter · makeSectionFilters: all sentinel accepted", () => {
  const s = makeSectionFilters("all");
  assert.equal(s.global, "all");
  assert.equal(hasAnyOverride(s), false);
});

// ─────────────────────────── getEffectiveFilter ───────────────────────────

test("W61-per-section-filter · getEffectiveFilter: returns global when no override", () => {
  const s = makeSectionFilters("user");
  assert.equal(getEffectiveFilter(s, "metrics"), "user");
  assert.equal(getEffectiveFilter(s, "dimensions"), "user");
  assert.equal(getEffectiveFilter(s, "hierarchies"), "user");
});

test("W61-per-section-filter · getEffectiveFilter: override beats global for its section only", () => {
  const seed = makeSectionFilters("user");
  const s = applyChipClick(seed, "metrics", "auto", true);
  assert.equal(getEffectiveFilter(s, "metrics"), "auto");
  assert.equal(getEffectiveFilter(s, "dimensions"), "user");
  assert.equal(getEffectiveFilter(s, "hierarchies"), "user");
});

// ─────────────────────────── isSectionOverridden ───────────────────────────

test("W61-per-section-filter · isSectionOverridden: false when override is null", () => {
  const s = makeSectionFilters("auto");
  assert.equal(isSectionOverridden(s, "metrics"), false);
  assert.equal(isSectionOverridden(s, "dimensions"), false);
  assert.equal(isSectionOverridden(s, "hierarchies"), false);
});

test("W61-per-section-filter · isSectionOverridden: true only for the overridden section", () => {
  const s = applyChipClick(
    makeSectionFilters("auto"),
    "dimensions",
    "domain",
    true,
  );
  assert.equal(isSectionOverridden(s, "metrics"), false);
  assert.equal(isSectionOverridden(s, "dimensions"), true);
  assert.equal(isSectionOverridden(s, "hierarchies"), false);
});

test("W61-per-section-filter · isSectionOverridden: true even when override value matches global", () => {
  // A redundant override (set to the same value as global) is still
  // an override — the admin's intent was per-section scope, not a
  // value-equality check. The reducer doesn't second-guess.
  const s = applyChipClick(makeSectionFilters("user"), "metrics", "user", true);
  assert.equal(isSectionOverridden(s, "metrics"), true);
});

// ─────────────────────────── applyChipClick — plain-click path ───────────────────────────

test("W61-per-section-filter · applyChipClick plain: sets global, clears all overrides", () => {
  const seed = applyChipClick(makeSectionFilters("all"), "metrics", "auto", true);
  const overrode2 = applyChipClick(seed, "dimensions", "user", true);
  // Now metrics=auto-override, dimensions=user-override, global=all.
  const synced = applyChipClick(overrode2, "hierarchies", "domain", false);
  assert.equal(synced.global, "domain");
  assert.equal(synced.overrides.metrics, null);
  assert.equal(synced.overrides.dimensions, null);
  assert.equal(synced.overrides.hierarchies, null);
});

test("W61-per-section-filter · applyChipClick plain on the same chip as global: still clears overrides", () => {
  // Edge case: admin shift-clicks metrics→auto override, then plain-
  // clicks metrics→user (which matches the original global). The
  // reducer treats it as the synced-update path: clear all overrides.
  const seed = applyChipClick(makeSectionFilters("user"), "metrics", "auto", true);
  const next = applyChipClick(seed, "metrics", "user", false);
  assert.equal(next.global, "user");
  assert.equal(next.overrides.metrics, null);
});

test("W61-per-section-filter · applyChipClick plain in section A clears section B's override", () => {
  // The "single exit path" semantics: a non-shift click anywhere
  // returns the page to fully-synced.
  const seed = applyChipClick(makeSectionFilters("all"), "metrics", "user", true);
  const next = applyChipClick(seed, "dimensions", "auto", false);
  assert.equal(next.global, "auto");
  assert.equal(next.overrides.metrics, null);
  assert.equal(next.overrides.dimensions, null);
  assert.equal(next.overrides.hierarchies, null);
});

// ─────────────────────────── applyChipClick — shift-click path ───────────────────────────

test("W61-per-section-filter · applyChipClick shift: sets this section's override only", () => {
  const seed = makeSectionFilters("all");
  const next = applyChipClick(seed, "metrics", "user", true);
  assert.equal(next.global, "all");
  assert.equal(next.overrides.metrics, "user");
  assert.equal(next.overrides.dimensions, null);
  assert.equal(next.overrides.hierarchies, null);
});

test("W61-per-section-filter · applyChipClick shift: replaces existing override on same section", () => {
  const seed = applyChipClick(makeSectionFilters("all"), "metrics", "user", true);
  const next = applyChipClick(seed, "metrics", "auto", true);
  assert.equal(next.overrides.metrics, "auto");
  assert.equal(next.global, "all");
});

test("W61-per-section-filter · applyChipClick shift: preserves overrides on OTHER sections", () => {
  // Two independent overrides can coexist.
  const seed = applyChipClick(makeSectionFilters("all"), "metrics", "user", true);
  const next = applyChipClick(seed, "dimensions", "auto", true);
  assert.equal(next.global, "all");
  assert.equal(next.overrides.metrics, "user");
  assert.equal(next.overrides.dimensions, "auto");
  assert.equal(next.overrides.hierarchies, null);
});

test("W61-per-section-filter · applyChipClick shift: preserves global value", () => {
  const seed = makeSectionFilters("domain");
  const next = applyChipClick(seed, "hierarchies", "user", true);
  assert.equal(next.global, "domain");
  assert.equal(next.overrides.hierarchies, "user");
});

// ─────────────────────────── hasAnyOverride ───────────────────────────

test("W61-per-section-filter · hasAnyOverride: false on fresh state", () => {
  assert.equal(hasAnyOverride(makeSectionFilters("all")), false);
});

test("W61-per-section-filter · hasAnyOverride: true when any single section overridden", () => {
  const m = applyChipClick(makeSectionFilters("all"), "metrics", "user", true);
  assert.equal(hasAnyOverride(m), true);
  const d = applyChipClick(makeSectionFilters("all"), "dimensions", "user", true);
  assert.equal(hasAnyOverride(d), true);
  const h = applyChipClick(makeSectionFilters("all"), "hierarchies", "user", true);
  assert.equal(hasAnyOverride(h), true);
});

test("W61-per-section-filter · hasAnyOverride: false after plain-click re-sync", () => {
  const seed = applyChipClick(makeSectionFilters("all"), "metrics", "user", true);
  assert.equal(hasAnyOverride(seed), true);
  const synced = applyChipClick(seed, "dimensions", "auto", false);
  assert.equal(hasAnyOverride(synced), false);
});

// ─────────────────────────── immutability pins ───────────────────────────

test("W61-per-section-filter · applyChipClick: does not mutate input state (shift path)", () => {
  const seed = makeSectionFilters("user");
  const seedSnapshot = JSON.stringify(seed);
  applyChipClick(seed, "metrics", "auto", true);
  assert.equal(JSON.stringify(seed), seedSnapshot);
});

test("W61-per-section-filter · applyChipClick: does not mutate input state (plain path)", () => {
  const seed = applyChipClick(makeSectionFilters("all"), "metrics", "user", true);
  const seedSnapshot = JSON.stringify(seed);
  applyChipClick(seed, "dimensions", "auto", false);
  assert.equal(JSON.stringify(seed), seedSnapshot);
});
