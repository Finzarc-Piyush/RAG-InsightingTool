// Presentational "Key insight" callout extracted verbatim from
// DataPreviewTable.tsx (god-file decomposition, behaviour-preserving code
// motion). Props-only, no shared state — a pure render of the chart insight
// state object.
import { Lightbulb, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';

export function ChartKeyInsightCallout({
  insight,
}: {
  insight: { text: string | null; loading: boolean; error: string | null } | null;
}) {
  if (!insight) return null;
  // No text yet and we're loading the first one — show a slim spinner.
  if (insight.loading && !insight.text) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Generating key insight…
      </div>
    );
  }
  // Error with no prior text to fall back on — show the error.
  if (insight.error && !insight.text) {
    return (
      <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        Key insight unavailable: {insight.error}
      </div>
    );
  }
  if (!insight.text) return null;
  return (
    <Card className="mt-3 p-3 bg-primary/5 border-l-4 border-l-primary shadow-sm border-border/60">
      <div className="flex items-center gap-2 mb-1.5">
        <Lightbulb className="w-4 h-4 text-primary" />
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
          Key insight
        </h4>
        {insight.loading && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Refreshing…
          </span>
        )}
      </div>
      <div className="text-sm text-foreground">
        <MarkdownRenderer content={insight.text} />
      </div>
      {insight.error && (
        <p className="mt-1.5 text-[11px] text-muted-foreground italic">
          Couldn't refresh: {insight.error}. Showing previous insight.
        </p>
      )}
    </Card>
  );
}
