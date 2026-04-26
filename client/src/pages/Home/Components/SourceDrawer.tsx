/**
 * W8 · SourceDrawer
 *
 * Right-sliding drawer that explains where the chart's numbers came from:
 *   - Tools called (name + rows in/out)
 *   - Columns referenced
 *   - Filters applied (range / equality)
 *   - SQL-equivalent (when available)
 *
 * Patterned after Perplexity's source side-panel and Claude.ai's "see used
 * data" affordance. Renders semantic tokens only (per client/THEMING.md).
 */
import type { ChartSpec } from "@/shared/schema";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type Provenance = NonNullable<ChartSpec["_agentProvenance"]>;

interface SourceDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chartTitle: string;
  provenance: Provenance;
}

export function SourceDrawer({
  open,
  onOpenChange,
  chartTitle,
  provenance,
}: SourceDrawerProps) {
  const { toolCalls, columnsUsed, rangeFilters, sqlEquivalent, sources } = provenance;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle>How this was computed</SheetTitle>
          <SheetDescription>
            Provenance for <span className="font-medium">{chartTitle}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          {toolCalls && toolCalls.length > 0 && (
            <section aria-label="Tools called">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Tools ({toolCalls.length})
              </h4>
              <ul className="space-y-2">
                {toolCalls.map((tc) => (
                  <li
                    key={tc.id}
                    className="rounded-brand-md border border-border/60 bg-card px-3 py-2"
                  >
                    <div className="font-mono text-[13px] text-foreground">{tc.tool}</div>
                    {(tc.rowsIn != null || tc.rowsOut != null) && (
                      <div className="mt-1 text-[12px] text-muted-foreground">
                        {tc.rowsIn != null && (
                          <span>
                            in: <strong>{tc.rowsIn.toLocaleString()}</strong> rows
                          </span>
                        )}
                        {tc.rowsIn != null && tc.rowsOut != null && (
                          <span className="mx-1.5">·</span>
                        )}
                        {tc.rowsOut != null && (
                          <span>
                            out: <strong>{tc.rowsOut.toLocaleString()}</strong> rows
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {columnsUsed && columnsUsed.length > 0 && (
            <section aria-label="Columns used">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Columns
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {columnsUsed.map((c, i) => (
                  <span
                    key={`${c}-${i}`}
                    className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[12px] text-foreground font-mono"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </section>
          )}

          {rangeFilters && rangeFilters.length > 0 && (
            <section aria-label="Filters applied">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Filters
              </h4>
              <ul className="space-y-1.5 text-[13px]">
                {rangeFilters.map((f, i) => (
                  <li
                    key={`${f.column}-${i}`}
                    className="rounded-brand-md border border-border/40 bg-muted/20 px-3 py-1.5"
                  >
                    <span className="font-mono text-foreground">{f.column}</span>{" "}
                    <span className="text-muted-foreground">{f.op}</span>{" "}
                    {f.value && <span className="text-foreground">{f.value}</span>}
                    {(f.min || f.max) && (
                      <span className="text-foreground">
                        [{f.min ?? "…"} … {f.max ?? "…"}]
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sources && sources.length > 0 && (
            <section aria-label="Data sources">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Sources
              </h4>
              <ul className="space-y-1 text-[13px] text-foreground">
                {sources.map((s, i) => (
                  <li key={i} className="font-mono">
                    {s}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sqlEquivalent && (
            <section aria-label="SQL equivalent">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                SQL equivalent
              </h4>
              <pre className="overflow-x-auto rounded-brand-md border border-border/40 bg-muted/30 p-3 text-[12px] leading-[18px] text-foreground">
                <code>{sqlEquivalent}</code>
              </pre>
            </section>
          )}

          {!toolCalls?.length &&
            !columnsUsed?.length &&
            !rangeFilters?.length &&
            !sqlEquivalent &&
            !sources?.length && (
              <p className="text-[13px] text-muted-foreground italic">
                Provenance details are not available for this chart.
              </p>
            )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
