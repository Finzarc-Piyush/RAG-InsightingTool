/**
 * /explore route — Chart Explorer. WC2.7.
 *
 * Reads a forked chart spec from the URL hash (`#spec=<base64-json>`)
 * and renders a fully editable <ChartCanvas>. Falls back to a friendly
 * empty state when the URL has no spec.
 *
 * Future waves:
 *   - Wire pivot raw-data fetch via <RawDataProvider> for chat-forked
 *     charts.
 *   - Side panel with EncodingShelves / FilterChips / LayersPanel.
 *   - "Save back to chat" affordance.
 */

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { ChartCanvas } from "@/components/charts/ChartCanvas";
import { decodeSpecFromHash } from "@/lib/charts/forkSpec";
import {
  isPremiumChartEnabled,
  V1_CHART_TYPES,
} from "@/lib/charts/featureFlags";
import type { ChartSpecV2 } from "@/shared/schema";

// F5 · Explorer rides on the chart v2 system, which defaults to flag-off.
// If every premium chart type is disabled, surface a friendly disabled state
// instead of letting authenticated users into a half-rolled-out editor.
function anyPremiumChartEnabled(): boolean {
  return V1_CHART_TYPES.some((t) => isPremiumChartEnabled(t));
}

function readHashSpec(): ChartSpecV2 | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const encoded = params.get("spec");
  return encoded ? decodeSpecFromHash(encoded) : null;
}

export default function Explore() {
  const [spec, setSpec] = useState<ChartSpecV2 | null>(() => readHashSpec());

  useEffect(() => {
    const onChange = () => setSpec(readHashSpec());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (!anyPremiumChartEnabled()) {
    return (
      <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">Chart Explorer is not enabled</h2>
        <p className="text-sm text-muted-foreground">
          The premium chart system is currently disabled. Enable a premium chart
          type via your environment or local settings to use the explorer.
        </p>
        <Link
          to="/analysis"
          className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to analysis
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <Link
          to="/analysis"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to analysis
        </Link>
        <div className="text-xs font-medium text-muted-foreground">
          Explorer
        </div>
      </div>

      {spec ? (
        <div className="flex-1 rounded-lg border border-border/80 bg-card p-4">
          <ChartCanvas spec={spec} height={520} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/80 bg-muted/10 p-12 text-center">
          <div className="text-sm font-medium text-foreground/80">
            No chart to explore
          </div>
          <div className="max-w-md text-xs text-muted-foreground">
            Click <span className="font-medium">Fork</span> on a chart in any
            chat answer or pivot to open it here for editing — chart type,
            encoding, filters, layers, exports.
          </div>
        </div>
      )}
    </div>
  );
}
