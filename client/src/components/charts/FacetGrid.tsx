/**
 * FacetGrid — small-multiples wrapper. WC4.4.
 *
 * When a v2 spec sets `encoding.facetCol` and/or `encoding.facetRow`,
 * PremiumChart partitions the data and renders one mini-chart per
 * facet group in a CSS grid. Scales are computed per facet by default;
 * a future enhancement will share scales across facets for fair
 * comparison.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface FacetCell {
  rowLabel?: string;
  colLabel?: string;
  /** Composite key for React reconciliation. */
  key: string;
  content: ReactNode;
}

export interface FacetGridProps {
  cells: FacetCell[];
  /** Wrap N facets per row (used when only facetCol is set). */
  columns?: number;
  /** Cell width / height — passed in by PremiumChart so cells fit budget. */
  cellWidth: number;
  cellHeight: number;
  className?: string;
}

export function FacetGrid({
  cells,
  columns,
  cellWidth,
  cellHeight,
  className,
}: FacetGridProps) {
  // Compose distinct row + col labels (when present) for headers.
  const colLabels = Array.from(
    new Set(cells.map((c) => c.colLabel ?? "").filter(Boolean)),
  );
  const rowLabels = Array.from(
    new Set(cells.map((c) => c.rowLabel ?? "").filter(Boolean)),
  );

  const isCrossTab = colLabels.length > 0 && rowLabels.length > 0;

  if (isCrossTab) {
    return (
      <div
        className={cn("grid gap-2", className)}
        style={{
          gridTemplateColumns: `auto repeat(${colLabels.length}, ${cellWidth}px)`,
        }}
      >
        <div />
        {colLabels.map((cl) => (
          <div
            key={`hdr-col-${cl}`}
            className="px-1 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            {cl}
          </div>
        ))}
        {rowLabels.map((rl) => (
          <div className="contents" key={`row-${rl}`}>
            <div
              className="flex items-center justify-end pr-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              style={{ height: cellHeight }}
            >
              {rl}
            </div>
            {colLabels.map((cl) => {
              const cell = cells.find(
                (c) => c.rowLabel === rl && c.colLabel === cl,
              );
              return (
                <div
                  key={`cell-${rl}-${cl}`}
                  className="overflow-hidden rounded-md border border-border/60 bg-card/40"
                  style={{ width: cellWidth, height: cellHeight }}
                >
                  {cell?.content ?? null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  // Single-axis facet (col xor row) — wrap into N columns.
  const cols = columns ?? Math.min(cells.length, 4);
  return (
    <div
      className={cn("grid gap-2", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {cells.map((cell) => (
        <div
          key={cell.key}
          className="flex flex-col gap-1 rounded-md border border-border/60 bg-card/40 p-1"
        >
          <div className="px-1 text-[11px] font-medium text-muted-foreground">
            {cell.colLabel ?? cell.rowLabel ?? cell.key}
          </div>
          <div style={{ height: cellHeight }}>{cell.content}</div>
        </div>
      ))}
    </div>
  );
}
