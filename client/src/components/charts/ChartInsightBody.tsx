import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { cn } from "@/lib/utils";
import { HelpCircle, Target } from "lucide-react";
import { splitChartInsightLanes } from "@/shared/chartInsightLanes";

/**
 * ChartInsightBody — the ONE presentational unit for a chart's auto-generated
 * insight: a tight manager-grade HEADLINE, an optional clearly-hedged
 * "Why it might be happening" line, an optional "Do" next step, plus the
 * optional 1–2 sentence domain "business context" framing (W12).
 *
 * The headline / why / do lanes are carried inside `keyInsight` via the shared
 * `WHY:` / `DO:` wire format ([splitChartInsightLanes]) the server emits, so this
 * renderer and the generator can never drift. A legacy `keyInsight` with no
 * markers parses as a headline-only blob → identical to the old rendering (full
 * back-compat). The Why/Do affordances reuse the same lucide icons + labelled
 * styling as the answer card's "Why this might be happening" / "Recommended
 * actions" sections, so a chart insight reads like the rest of the manager-grade
 * surface — just more compact.
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
  /** Domain framing — rendered as a "Business context:" block. */
  businessCommentary?: string;
  /**
   * `'on-accent'` = this body is hosted on a COLORED panel (e.g. the chat zoom's
   * blue "Key Insight" card). The Why/Do lines and the business-context block
   * then drop their own neutral chrome and instead inherit the host surface (a
   * hairline divider + inherited text) so they harmonize instead of clashing.
   * Default = the standalone neutral treatment used on muted/transparent surfaces.
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
  const lanes = hasKey ? splitChartInsightLanes(keyInsight!) : null;

  return (
    <>
      {lanes ? (
        <>
          {lanes.headline ? <MarkdownRenderer content={lanes.headline} /> : null}
          {lanes.why ? (
            <p
              className={cn(
                "mt-1.5 flex items-start gap-1.5 text-[12px] italic leading-snug",
                onAccent ? "opacity-90" : "text-muted-foreground",
              )}
              aria-label="Why it might be happening"
            >
              <HelpCircle
                className={cn(
                  "mt-[2px] h-3 w-3 shrink-0",
                  onAccent ? "opacity-80" : "text-primary/70",
                )}
                aria-hidden="true"
              />
              <span>
                <span
                  className={cn(
                    "not-italic font-semibold",
                    onAccent ? undefined : "text-foreground/80",
                  )}
                >
                  Why:{" "}
                </span>
                {lanes.why}
              </span>
            </p>
          ) : null}
          {lanes.do ? (
            <p
              className={cn(
                "mt-1 flex items-start gap-1.5 text-[12px] leading-snug",
                onAccent ? undefined : "text-foreground/90",
              )}
              aria-label="What we can do"
            >
              <Target
                className={cn(
                  "mt-[2px] h-3 w-3 shrink-0",
                  onAccent ? "opacity-80" : "text-primary/70",
                )}
                aria-hidden="true"
              />
              <span>
                <span className="font-semibold">Do: </span>
                {lanes.do}
              </span>
            </p>
          ) : null}
        </>
      ) : null}
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
