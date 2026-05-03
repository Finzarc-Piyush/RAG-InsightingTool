/**
 * ChatChartCard — read-only chart wrapper for chat messages with a
 * Fork-to-Explorer button. WC2.7.
 *
 * The chat metaphor: a message is a transcript artifact. We don't
 * mutate it in-place. ChatChartCard renders the chart read-only
 * (no MarkPicker, no shelves) plus a small Fork button that opens
 * the same chart in /explore with full editing.
 */

import { ArrowUpRight } from "lucide-react";
import { useMemo } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { applyTransforms } from "@/lib/charts/dataEngine";
import { rowsFromSource, useRawData } from "@/lib/charts/RawDataProvider";
import { explorerUrlFromSpec } from "@/lib/charts/forkSpec";
import type { ChartSpecV2 } from "@/shared/schema";
import { PremiumChart } from "./PremiumChart";

export interface ChatChartCardProps {
  spec: ChartSpecV2;
  height?: number;
  className?: string;
  /** Hide the Fork button (used by callers that already render their own). */
  hideForkButton?: boolean;
  /** Preserved through the read-only chat card so future expand-to-modal
   *  callers can fetch a Key Insight on demand (Fix-4). */
  keyInsightSessionId?: string | null;
}

export function ChatChartCard({
  spec,
  height = 280,
  className,
  hideForkButton = false,
  keyInsightSessionId,
}: ChatChartCardProps) {
  const [, navigate] = useLocation();
  const ctx = useRawData();
  const sourceRows = useMemo(
    () => rowsFromSource(spec.source, ctx),
    [spec.source, ctx],
  );
  const data = useMemo(
    () => applyTransforms(sourceRows, spec.transform),
    [sourceRows, spec.transform],
  );
  const title = spec.config?.title?.text;

  const onFork = () => {
    navigate(explorerUrlFromSpec(spec));
  };

  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)}>
      {(title || !hideForkButton) && (
        <div className="flex items-start justify-between gap-3">
          {title && (
            <div className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground">
              {title}
            </div>
          )}
          {!hideForkButton && (
            <button
              type="button"
              onClick={onFork}
              className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-card px-2 py-0.5 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-muted/40"
              aria-label="Fork this chart to the Explorer for editing"
              title="Open in Explorer to edit"
            >
              <ArrowUpRight className="h-3 w-3" />
              Fork
            </button>
          )}
        </div>
      )}
      <PremiumChart
        spec={spec}
        data={data}
        height={height}
        keyInsightSessionId={keyInsightSessionId}
      />
    </div>
  );
}
