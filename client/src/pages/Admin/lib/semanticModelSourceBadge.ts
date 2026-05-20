/**
 * W61-source-badge · Source-chip colour + label + tooltip mapping for
 * the admin semantic-model viewer.
 *
 * Every metric / dimension / hierarchy entry carries a `source` field
 * (`"auto" | "user" | "domain"` — see `semanticMetricSchema` /
 * `semanticDimensionSchema` / `semanticHierarchySchema` in
 * [server/shared/schema.ts](../../../../../server/shared/schema.ts)).
 * W57's inference pipeline writes everything as `"auto"`; W61-source-bump
 * now stamps `"user"` on the server side whenever an admin edit lands.
 * `"domain"` is reserved for future entries promoted from a domain pack
 * (e.g. `kpi-and-metric-glossary`); none ship from the inference pipeline
 * yet, so most rows today are `"auto"` with the `"user"` chip surfacing
 * after the first edit.
 *
 * Variants intentionally lean on the pre-existing Badge palette so a
 * future re-theme propagates automatically:
 *   - auto   → `secondary` (muted) so the default state recedes
 *   - user   → `default`   (primary) so admin overrides pop
 *   - domain → `gold`      (accent) so pack-sourced entries read as
 *              "this came from elsewhere, treat as authoritative"
 *
 * Pure module — no React, no DOM. The chip component itself lives in
 * `AdminSemanticModelDetail.tsx` next to the other inline-edit
 * primitives so it stays co-located with its only call site.
 */

import type { BadgeProps } from "@/components/ui/badge";

/**
 * Mirrors the `source` enum in `semanticMetricSchema` /
 * `semanticDimensionSchema` / `semanticHierarchySchema`. Kept as a
 * local alias rather than re-exported from `@/shared/schema` so a
 * future schema split (e.g. metric-source vs dimension-source) doesn't
 * silently widen the chip's accepted inputs.
 */
export type SemanticEntrySource = "auto" | "user" | "domain";

const SOURCE_LABELS: Readonly<Record<SemanticEntrySource, string>> = {
  auto: "Auto",
  user: "User",
  domain: "Domain",
};

const SOURCE_VARIANTS: Readonly<
  Record<SemanticEntrySource, NonNullable<BadgeProps["variant"]>>
> = {
  auto: "secondary",
  user: "default",
  domain: "gold",
};

const SOURCE_TOOLTIPS: Readonly<Record<SemanticEntrySource, string>> = {
  auto: "Auto-inferred from the dataset by the W57 inference pipeline.",
  user: "Manually edited by an admin via this viewer.",
  domain: "Imported from a domain pack (e.g. kpi-and-metric-glossary).",
};

export function getSourceBadgeLabel(source: SemanticEntrySource): string {
  return SOURCE_LABELS[source];
}

export function getSourceBadgeVariant(
  source: SemanticEntrySource,
): NonNullable<BadgeProps["variant"]> {
  return SOURCE_VARIANTS[source];
}

export function getSourceBadgeTooltip(source: SemanticEntrySource): string {
  return SOURCE_TOOLTIPS[source];
}
