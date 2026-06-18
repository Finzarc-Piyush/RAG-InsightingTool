import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { cn } from "@/lib/utils";

/**
 * ChartInsightBody — the ONE presentational unit for a chart's auto-generated
 * insight: the plain-English key-insight prose (markdown) plus the optional
 * 1–2 sentence domain "business context" framing (W12).
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
  /** Plain-English key-insight prose (markdown). */
  keyInsight?: string;
  /** Domain framing — rendered as a "Business context:" block. */
  businessCommentary?: string;
  /**
   * `'on-accent'` = this body is hosted on a COLORED panel (e.g. the chat zoom's
   * blue "Key Insight" card). The business-context block then drops its own
   * neutral muted card and instead inherits the host surface (a hairline
   * divider + inherited text) so it harmonizes instead of clashing. Default =
   * the standalone neutral card used on muted/transparent surfaces.
   */
  tone?: "default" | "on-accent";
}

export function ChartInsightBody({
  keyInsight,
  businessCommentary,
  tone = "default",
}: ChartInsightBodyProps) {
  const hasKey = typeof keyInsight === "string" && keyInsight.trim().length > 0;
  const hasCommentary =
    typeof businessCommentary === "string" && businessCommentary.trim().length > 0;

  if (!hasKey && !hasCommentary) return null;

  const onAccent = tone === "on-accent";

  return (
    <>
      {hasKey ? <MarkdownRenderer content={keyInsight!} /> : null}
      {hasCommentary ? (
        <p
          className={cn(
            "text-[12px] italic leading-snug",
            onAccent
              ? "mt-2 border-t border-current/15 pt-2"
              : "rounded-brand-md border border-border/40 bg-muted/30 px-3 py-2 text-foreground/80",
          )}
          aria-label="Business commentary"
        >
          <span
            className={cn(
              "not-italic font-semibold mr-1",
              onAccent ? "opacity-70" : "text-muted-foreground",
            )}
          >
            Business context:
          </span>
          {businessCommentary}
        </p>
      ) : null}
    </>
  );
}
