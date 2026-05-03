/**
 * ChartShim — backwards-compatibility adapter that lets existing v1
 * ChartSpec callers (chat MessageBubble, dashboard cards, pivot panel)
 * opt into the v2 PremiumChart renderer one mark at a time.
 *
 * Resolution:
 *   - If the spec is already v2 (has `version: 2`): render <PremiumChart>.
 *   - Else if the v1 type's premium feature flag is enabled
 *     (env / localStorage / default — see featureFlags.ts):
 *       convert v1 → v2 and render <PremiumChart>.
 *   - Else: render the legacy <ChartRenderer> via the `legacy` prop.
 *
 * The legacy renderer is passed in as a render prop to avoid a hard
 * import of the 1,820-line ChartRenderer from this small adapter — it
 * keeps bundle topology clean and lets the shim live in
 * `components/charts/` even though ChartRenderer lives elsewhere.
 */

import { lazy, Suspense, useMemo, type ReactNode } from "react";
import {
  isPremiumChartEnabled,
  type ChartV1Type,
  V1_CHART_TYPES,
} from "@/lib/charts/featureFlags";
import { convertV1ToV2 } from "@/lib/charts/v1ToV2";
import { isChartSpecV2, type ChartSpec, type ChartSpecV2 } from "@/shared/schema";

// F6 · Lazy-load PremiumChart so Visx + ECharts (~280 KB) only ship to users
// who actually have a premium chart flag flipped on. Without this the chunk
// is statically imported and ships in the main bundle even when every flag
// defaults to false, defeating the gated rollout for bundle size.
const PremiumChart = lazy(() =>
  import("./PremiumChart").then((m) => ({ default: m.PremiumChart })),
);

export interface ChartShimProps {
  spec: ChartSpec | ChartSpecV2;
  /** Render-prop for the legacy renderer (avoid hard import). */
  legacy: () => ReactNode;
  /** Optional fixed height for PremiumChart. */
  height?: number;
  /** Optional aria override. */
  ariaLabel?: string;
  /**
   * Forwarded into PremiumChart. Preserved through the shim so flag
   * flips don't lose the Key Insight feature (Fix-4).
   */
  keyInsightSessionId?: string | null;
}

function isV1Type(t: unknown): t is ChartV1Type {
  return (
    typeof t === "string" && (V1_CHART_TYPES as readonly string[]).includes(t)
  );
}

export function ChartShim({
  spec,
  legacy,
  height,
  ariaLabel,
  keyInsightSessionId,
}: ChartShimProps) {
  // v2 always goes through PremiumChart. Suspense fallback shows the legacy
  // render so users see a chart instead of a spinner during the (rare) load.
  if (isChartSpecV2(spec)) {
    const inlineRows =
      spec.source.kind === "inline" ? (spec.source.rows as unknown[]) : [];
    return (
      <Suspense fallback={<>{legacy()}</>}>
        <PremiumChart
          spec={spec}
          data={inlineRows as Array<Record<string, unknown>>}
          height={height}
          ariaLabel={ariaLabel}
          keyInsightSessionId={keyInsightSessionId}
        />
      </Suspense>
    );
  }

  // v1: check the per-type feature flag.
  const v1 = spec as ChartSpec;
  const usePremium = isV1Type(v1.type) ? isPremiumChartEnabled(v1.type) : false;

  const converted = useMemo(() => {
    if (!usePremium) return null;
    return convertV1ToV2(v1);
  }, [usePremium, v1]);

  if (!usePremium || !converted) {
    return <>{legacy()}</>;
  }

  const inlineRows =
    converted.spec.source.kind === "inline"
      ? (converted.spec.source.rows as unknown[])
      : [];

  return (
    <Suspense fallback={<>{legacy()}</>}>
      <PremiumChart
        spec={converted.spec}
        data={inlineRows as Array<Record<string, unknown>>}
        height={height}
        ariaLabel={ariaLabel}
        keyInsightSessionId={keyInsightSessionId}
      />
    </Suspense>
  );
}
