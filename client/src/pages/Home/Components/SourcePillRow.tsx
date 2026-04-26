/**
 * W8 · SourcePillRow
 *
 * Compact source-citation pill rendered under each chart, summarizing the
 * provenance the agent emitted (rows scanned, columns, tool count). Clicking
 * the pill opens the SourceDrawer with the full breakdown.
 *
 * Patterned after Perplexity's inline source pills. Uses semantic tokens.
 */
import { useState, useMemo } from "react";
import type { ChartSpec } from "@/shared/schema";
import { Database } from "lucide-react";
import { SourceDrawer } from "./SourceDrawer";

interface SourcePillRowProps {
  chart: ChartSpec & { _agentProvenance?: NonNullable<ChartSpec["_agentProvenance"]> };
}

export function SourcePillRow({ chart }: SourcePillRowProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const provenance = chart._agentProvenance;

  const summary = useMemo(() => {
    if (!provenance) return null;
    const parts: string[] = [];
    const totalRows = (provenance.toolCalls ?? []).reduce(
      (acc, tc) => acc + (tc.rowsOut ?? tc.rowsIn ?? 0),
      0
    );
    if (totalRows > 0) parts.push(`${totalRows.toLocaleString()} rows`);
    if (provenance.columnsUsed?.length) {
      parts.push(`${provenance.columnsUsed.length} cols`);
    }
    if (provenance.toolCalls?.length) {
      parts.push(`${provenance.toolCalls.length} tools`);
    }
    return parts.length ? parts.join(" · ") : null;
  }, [provenance]);

  if (!provenance || !summary) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Show data sources for ${chart.title}`}
        aria-haspopup="dialog"
      >
        <Database className="h-3 w-3" aria-hidden="true" />
        {summary}
      </button>
      <SourceDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        chartTitle={chart.title}
        provenance={provenance}
      />
    </>
  );
}
