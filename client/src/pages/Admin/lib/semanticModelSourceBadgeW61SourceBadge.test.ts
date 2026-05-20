/**
 * Wave W61-source-badge · helper coverage.
 *
 * The chip component itself lives in AdminSemanticModelDetail.tsx;
 * these tests pin the pure label / variant / tooltip mappings so a
 * drift in the source enum (or a re-theme that flips which Badge
 * variant means what) lands as a test failure rather than a silent
 * visual regression.
 *
 * The source enum is byte-locked to the zod schemas — a future
 * widening of `SemanticMetric.source` to a 4th value should land here
 * first (test fails because the new value has no label/variant/tooltip),
 * then in the helper module.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getSourceBadgeLabel,
  getSourceBadgeTooltip,
  getSourceBadgeVariant,
  type SemanticEntrySource,
} from "./semanticModelSourceBadge.js";

const ALL_SOURCES: readonly SemanticEntrySource[] = [
  "auto",
  "user",
  "domain",
] as const;

test("W61-source-badge · getSourceBadgeLabel: auto → 'Auto'", () => {
  assert.equal(getSourceBadgeLabel("auto"), "Auto");
});

test("W61-source-badge · getSourceBadgeLabel: user → 'User'", () => {
  assert.equal(getSourceBadgeLabel("user"), "User");
});

test("W61-source-badge · getSourceBadgeLabel: domain → 'Domain'", () => {
  assert.equal(getSourceBadgeLabel("domain"), "Domain");
});

test("W61-source-badge · getSourceBadgeVariant: auto → secondary (muted)", () => {
  // Muted is the canonical "background metadata" variant on the Badge
  // primitive — auto-inferred entries should not visually compete with
  // user-edited ones.
  assert.equal(getSourceBadgeVariant("auto"), "secondary");
});

test("W61-source-badge · getSourceBadgeVariant: user → default (primary)", () => {
  // Admin overrides pop in the primary brand tint — the chip's job
  // after W61-source-bump is to make "I touched this" scannable.
  assert.equal(getSourceBadgeVariant("user"), "default");
});

test("W61-source-badge · getSourceBadgeVariant: domain → gold (accent)", () => {
  // Pack-sourced entries lean on the UX-2 signature accent so they
  // read as "imported authoritative knowledge" rather than admin
  // overrides.
  assert.equal(getSourceBadgeVariant("domain"), "gold");
});

test("W61-source-badge · getSourceBadgeTooltip: auto mentions inference pipeline", () => {
  const t = getSourceBadgeTooltip("auto");
  assert.match(t, /auto-inferred/i);
});

test("W61-source-badge · getSourceBadgeTooltip: user mentions admin edit", () => {
  const t = getSourceBadgeTooltip("user");
  assert.match(t, /admin/i);
});

test("W61-source-badge · getSourceBadgeTooltip: domain mentions domain pack", () => {
  const t = getSourceBadgeTooltip("domain");
  assert.match(t, /domain pack/i);
});

test("W61-source-badge · every source has a non-empty label", () => {
  for (const s of ALL_SOURCES) {
    assert.ok(
      getSourceBadgeLabel(s).length > 0,
      `${s} should have a non-empty label`,
    );
  }
});

test("W61-source-badge · every source has a non-empty tooltip", () => {
  for (const s of ALL_SOURCES) {
    assert.ok(
      getSourceBadgeTooltip(s).length > 0,
      `${s} should have a non-empty tooltip`,
    );
  }
});

test("W61-source-badge · labels are distinct across sources", () => {
  const labels = ALL_SOURCES.map(getSourceBadgeLabel);
  assert.equal(
    new Set(labels).size,
    ALL_SOURCES.length,
    "Each source should have a distinct label",
  );
});

test("W61-source-badge · variants are distinct across sources", () => {
  // Two sources sharing a Badge variant would defeat the chip's
  // scan-at-a-glance purpose.
  const variants = ALL_SOURCES.map(getSourceBadgeVariant);
  assert.equal(
    new Set(variants).size,
    ALL_SOURCES.length,
    "Each source should map to a distinct Badge variant",
  );
});

test("W61-source-badge · tooltips are distinct across sources", () => {
  const tooltips = ALL_SOURCES.map(getSourceBadgeTooltip);
  assert.equal(
    new Set(tooltips).size,
    ALL_SOURCES.length,
    "Each source should have a distinct tooltip",
  );
});

test("W61-source-badge · variant for 'user' is not the same as 'auto' (admin edits must be visually distinct)", () => {
  // Load-bearing for the W61-source-bump payoff: after the server
  // stamps source="user" on every edit, the admin needs the chip to
  // visually flip so they can see which entries they've corrected.
  assert.notEqual(getSourceBadgeVariant("user"), getSourceBadgeVariant("auto"));
});

test("W61-source-badge · variant for 'domain' is not the same as 'user' (pack imports must be visually distinct from admin overrides)", () => {
  // Pack-sourced entries should NOT look like admin overrides — a
  // future maintainer needs to distinguish "the legal team blessed
  // this" from "an admin tweaked this".
  assert.notEqual(
    getSourceBadgeVariant("domain"),
    getSourceBadgeVariant("user"),
  );
});

test("W61-source-badge · auto tooltip references the W57 pipeline by name", () => {
  // Discoverability anchor — a future admin reading the chip can
  // grep `W57` in the codebase to find the inference module.
  const t = getSourceBadgeTooltip("auto");
  assert.match(t, /W57/);
});

test("W61-source-badge · domain tooltip references the kpi-and-metric-glossary pack as an example", () => {
  // The only domain pack currently in production that emits semantic
  // entries. Anchoring the tooltip to a concrete example helps the
  // admin understand which packs the field could refer to.
  const t = getSourceBadgeTooltip("domain");
  assert.match(t, /kpi-and-metric-glossary/);
});
