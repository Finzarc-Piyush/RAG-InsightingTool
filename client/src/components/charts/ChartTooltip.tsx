/**
 * ChartTooltip — premium tooltip card for chart hover detail. WC1.1.
 *
 * Renders an HTML card (not SVG) so the browser handles z-index, text
 * layout, and font rendering natively. Pure semantic Tailwind tokens
 * (bg-card, text-foreground, border-border, etc.) — works in light +
 * dark + high-contrast without any extra wiring.
 *
 * Used by:
 *   - Visx renderers via `@visx/tooltip` (TooltipWithBounds wraps this).
 *   - ECharts renderers via the `tooltip.formatter` option that returns
 *     this component's HTML rendered to a string. (formatter signature
 *     is sync; we'll renderToStaticMarkup once per hover.)
 *
 * Design notes:
 *   - Title row: bold field/series, muted subtitle for time/category.
 *   - Body rows: tabular alignment via grid; left = swatch + label,
 *     right = formatted value.
 *   - Optional comparison row: muted "vs prior period" delta.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ChartTooltipRow {
  /** Color swatch (any CSS color, typically `hsl(var(--chart-N))`). */
  color?: string;
  /** Series / field label. */
  label: string;
  /** Pre-formatted value to display in the right column. */
  value: string;
  /** Optional muted line below the value (e.g., delta). */
  subValue?: string;
  /** Strong-emphasis row (winner / focused). */
  emphasized?: boolean;
}

export interface ChartTooltipProps {
  /** Bold title — typically the x-axis category or hovered point label. */
  title?: ReactNode;
  /** Muted subtitle below title — typically date or sub-category. */
  subtitle?: ReactNode;
  /** Body rows. */
  rows: ChartTooltipRow[];
  /** Optional footer line (e.g., "n=42 records"). */
  footer?: ReactNode;
  /** Override className on the root card. */
  className?: string;
  /** Compact mode shrinks paddings — used in dense small-multiple panels. */
  compact?: boolean;
}

/**
 * Plain React tooltip — used by visx via `TooltipWithBounds`.
 */
export function ChartTooltip({
  title,
  subtitle,
  rows,
  footer,
  className,
  compact = false,
}: ChartTooltipProps) {
  return (
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none rounded-lg border border-border/80 bg-card text-foreground shadow-md backdrop-blur-sm",
        compact ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-2 text-xs",
        "min-w-[140px] max-w-[280px]",
        className,
      )}
    >
      {title && (
        <div
          className={cn(
            "font-semibold tracking-tight text-foreground",
            compact ? "text-[11px]" : "text-xs",
          )}
        >
          {title}
        </div>
      )}
      {subtitle && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {subtitle}
        </div>
      )}
      {rows.length > 0 && (
        <div
          className={cn(
            "mt-1.5 grid gap-x-3 gap-y-1",
            "grid-cols-[auto_1fr_auto] items-center",
          )}
        >
          {rows.map((row, i) => (
            <ChartTooltipRowView key={`${row.label}-${i}`} row={row} />
          ))}
        </div>
      )}
      {footer && (
        <div className="mt-1.5 border-t border-border/60 pt-1 text-[10px] text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

function ChartTooltipRowView({ row }: { row: ChartTooltipRow }) {
  return (
    <>
      <span
        aria-hidden
        className="h-2 w-2 rounded-sm"
        style={row.color ? { backgroundColor: row.color } : undefined}
      />
      <span
        className={cn(
          "min-w-0 truncate",
          row.emphasized ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {row.label}
      </span>
      <span
        className={cn(
          "text-right tabular-nums",
          row.emphasized
            ? "font-semibold text-foreground"
            : "text-foreground/90",
        )}
      >
        {row.value}
        {row.subValue && (
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            {row.subValue}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Render a ChartTooltip to a plain HTML string. ECharts uses this for
 * its `tooltip.formatter` option (which expects a sync HTML string).
 * Lazy-imports react-dom/server to avoid pulling it into the main
 * client bundle.
 */
export async function renderChartTooltipHtml(
  props: ChartTooltipProps,
): Promise<string> {
  const [{ renderToStaticMarkup }, { createElement }] = await Promise.all([
    import("react-dom/server"),
    import("react"),
  ]);
  return renderToStaticMarkup(createElement(ChartTooltip, props));
}
