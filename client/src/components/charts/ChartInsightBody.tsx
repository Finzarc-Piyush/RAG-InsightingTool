import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { cn } from "@/lib/utils";
import { HelpCircle, Target } from "lucide-react";
import {
  splitChartInsightLanes,
  stripDashboardMetaAdviceDoLane,
} from "@/shared/chartInsightLanes";
import { renderInsightText } from "@/lib/insightText";

/**
 * ChartInsightBody — the ONE presentational unit for a chart's auto-generated
 * insight: a tight manager-grade HEADLINE, an optional clearly-hedged
 * "Why it might be happening" line, and an optional "Do" next step.
 *
 * The headline / why / do lanes are carried inside `keyInsight` via the shared
 * `WHY:` / `DO:` wire format ([splitChartInsightLanes]) the server emits, so this
 * renderer and the generator can never drift. A legacy `keyInsight` with no
 * markers parses as a headline-only blob → identical to the old rendering (full
 * back-compat). The Why/Do affordances reuse the same lucide icons + labelled
 * styling as the answer card's "Why this might be happening" / "Recommended
 * actions" sections, so a chart insight reads like the rest of the manager-grade
 * surface — and at the SAME (normal) text size as the headline, not a smaller
 * footnote.
 *
 * Shared so every surface that shows a chart's insight renders it identically:
 * the chat answer bubble ([MessageBubble]), the dashboard tile footer
 * ([TileInsightFooter]), the chat + dashboard zoom modals, and the multi-chart
 * chat response all render through this, instead of each owning a private copy
 * of the markup.
 *
 * Pure & chrome-free by design: collapse/expand, regenerate, history, and the
 * "no insight yet" placeholder live in the surface wrapper (the dashboard footer
 * has them; chat doesn't). Each surface passes only the fields it currently
 * shows; the component renders whatever it is given and nothing when given
 * nothing (so callers can drop their own `&&` guards).
 */
export interface ChartInsightBodyProps {
  /** Plain-English key-insight prose, carrying optional WHY:/DO: lanes (markdown). */
  keyInsight?: string;
  /**
   * `'on-accent'` = this body is hosted on a COLORED panel (e.g. the chat zoom's
   * blue "Key Insight" card). The Why/Do lines then drop their own neutral chrome
   * and instead inherit the host surface so they harmonize instead of clashing.
   * Default = the standalone neutral treatment used on muted/transparent surfaces.
   */
  tone?: "default" | "on-accent";
  /**
   * Deterministic "Do" action used ONLY when `keyInsight` carries no `DO:` lane
   * of its own (e.g. an insight persisted before the always-show-a-Do change).
   * The dashboard tile derives this from the chart's own data
   * ([deriveTileDoLane]) so a managerial next step still renders without a
   * regeneration. Omitted on chat surfaces → behaviour unchanged there.
   */
  fallbackDo?: string;
}

export function ChartInsightBody({
  keyInsight,
  tone = "default",
  fallbackDo,
}: ChartInsightBodyProps) {
  const hasKey = typeof keyInsight === "string" && keyInsight.trim().length > 0;

  if (!hasKey) return null;

  const onAccent = tone === "on-accent";
  // Belt-and-suspenders for dashboards saved BEFORE the server-side DO gate:
  // suppress a persisted "build a dashboard to track this" DO lane at render
  // too, off the SAME shared vocabulary, so existing tiles read like a
  // managerial action without a regeneration (L-018 "fix both ends").
  const lanes = splitChartInsightLanes(stripDashboardMetaAdviceDoLane(keyInsight!));

  // Always show a "Do" for managers: when the insight itself carries no DO
  // lane (e.g. a tile persisted before the always-show-a-Do change), fall back
  // to the deterministic, data-derived action the surface passed in. The
  // insight's own DO lane always wins when present.
  const doText =
    lanes.do && lanes.do.trim()
      ? lanes.do
      : fallbackDo && fallbackDo.trim()
        ? fallbackDo
        : undefined;

  return (
    <>
      {lanes.headline ? <MarkdownRenderer content={lanes.headline} /> : null}
      {lanes.why ? (
        <p
          className={cn(
            "mt-1.5 flex items-start gap-1.5 leading-snug",
            onAccent ? "opacity-90" : "text-muted-foreground",
          )}
          aria-label="Why it might be happening"
        >
          <HelpCircle
            className={cn(
              "mt-[3px] h-3.5 w-3.5 shrink-0",
              onAccent ? "opacity-80" : "text-primary/70",
            )}
            aria-hidden="true"
          />
          <span>
            <span
              className={cn(
                "font-semibold",
                onAccent ? undefined : "text-foreground/80",
              )}
            >
              Why:{" "}
            </span>
            {renderInsightText(lanes.why)}
          </span>
        </p>
      ) : null}
      {doText ? (
        <p
          className={cn(
            "mt-1 flex items-start gap-1.5 leading-snug",
            onAccent ? undefined : "text-foreground/90",
          )}
          aria-label="What we can do"
        >
          <Target
            className={cn(
              "mt-[3px] h-3.5 w-3.5 shrink-0",
              onAccent ? "opacity-80" : "text-primary/70",
            )}
            aria-hidden="true"
          />
          <span>
            <span className="font-semibold">Do: </span>
            {renderInsightText(doText)}
          </span>
        </p>
      ) : null}
    </>
  );
}
