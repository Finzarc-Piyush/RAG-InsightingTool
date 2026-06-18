import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

/**
 * ChartInsightBody — the ONE presentational unit for a chart's auto-generated
 * insight: the plain-English key-insight prose (markdown) plus the optional
 * 1–2 sentence domain "business context" framing (W12).
 *
 * Shared so every surface that shows a chart's insight renders it identically:
 * the chat answer bubble ([MessageBubble]) and the dashboard tile footer
 * ([TileInsightFooter]) both render through this, instead of each owning a
 * private copy of the markup.
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
  /** Domain framing — rendered as a muted "Business context:" block. */
  businessCommentary?: string;
}

export function ChartInsightBody({ keyInsight, businessCommentary }: ChartInsightBodyProps) {
  const hasKey = typeof keyInsight === "string" && keyInsight.trim().length > 0;
  const hasCommentary =
    typeof businessCommentary === "string" && businessCommentary.trim().length > 0;

  if (!hasKey && !hasCommentary) return null;

  return (
    <>
      {hasKey ? <MarkdownRenderer content={keyInsight!} /> : null}
      {hasCommentary ? (
        <p
          className="rounded-brand-md border border-border/40 bg-muted/30 px-3 py-2 text-[12px] italic leading-snug text-foreground/80"
          aria-label="Business commentary"
        >
          <span className="not-italic font-semibold text-muted-foreground mr-1">
            Business context:
          </span>
          {businessCommentary}
        </p>
      ) : null}
    </>
  );
}
