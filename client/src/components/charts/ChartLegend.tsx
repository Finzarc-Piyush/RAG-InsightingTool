/**
 * ChartLegend — interactive legend with hover-dim + click-isolate.
 * WC1.3.
 *
 * Behavior:
 *   - Hover a chip → other series dim to 0.25 opacity (handled by the
 *     renderer reading `hovered` from useChartLegendState).
 *   - Click a chip → that series is *isolated* (others hidden). Click
 *     again → un-isolate (everything visible).
 *   - Shift-click a chip → toggle that single series' visibility.
 *   - "Show all" button appears when any series is hidden.
 *
 * Designed for ≤24 series. Beyond that, renderer should use a wide
 * legend with overflow scroll (TBD in WC1.3 follow-on).
 */

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";

export interface ChartLegendItem {
  key: string;
  color: string;
  /** Display label; defaults to key. */
  label?: string;
}

export interface ChartLegendState {
  hovered: string | null;
  hidden: Set<string>;
}

const EMPTY_HIDDEN = new Set<string>();

const initialState: ChartLegendState = {
  hovered: null,
  hidden: EMPTY_HIDDEN,
};

/** Hook returning state + handlers for renderers + ChartLegend chips. */
export function useChartLegendState(items: ChartLegendItem[]) {
  const [state, setState] = useState<ChartLegendState>(initialState);

  const onHover = useCallback((key: string | null) => {
    setState((s) => (s.hovered === key ? s : { ...s, hovered: key }));
  }, []);

  const onClick = useCallback(
    (key: string, e?: React.MouseEvent) => {
      const shift = !!e?.shiftKey;
      setState((s) => {
        const next = new Set(s.hidden);
        if (shift) {
          // Toggle just this one.
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return { ...s, hidden: next };
        }
        // Click-to-isolate / click-again-to-un-isolate.
        const allKeys = items.map((i) => i.key);
        const others = allKeys.filter((k) => k !== key);
        const allOthersHidden = others.every((k) => next.has(k));
        if (allOthersHidden && !next.has(key)) {
          // Currently isolated to this key; un-isolate.
          return { ...s, hidden: EMPTY_HIDDEN };
        }
        return { ...s, hidden: new Set(others) };
      });
    },
    [items],
  );

  const onShowAll = useCallback(() => {
    setState((s) => ({ ...s, hidden: EMPTY_HIDDEN }));
  }, []);

  return { state, onHover, onClick, onShowAll };
}

export interface ChartLegendProps {
  items: ChartLegendItem[];
  state: ChartLegendState;
  onHover: (key: string | null) => void;
  onClick: (key: string, e?: React.MouseEvent) => void;
  onShowAll: () => void;
  className?: string;
  /** Compact mode shrinks chip padding for dashboard tiles. */
  compact?: boolean;
  /** When set, renders chips in a flex-col instead of flex-wrap row. */
  vertical?: boolean;
}

/** Render the legend chips. Renderers compose this above/below their SVG. */
export function ChartLegend({
  items,
  state,
  onHover,
  onClick,
  onShowAll,
  className,
  compact = false,
  vertical = false,
}: ChartLegendProps) {
  if (items.length === 0) return null;
  const anyHidden = state.hidden.size > 0;
  const hasHover = state.hovered !== null;

  return (
    <div
      role="group"
      aria-label="Chart legend"
      className={cn(
        "flex items-center text-xs",
        vertical
          ? "flex-col items-start gap-1"
          : "flex-wrap gap-x-2 gap-y-1",
        className,
      )}
    >
      {items.map((it) => {
        const hidden = state.hidden.has(it.key);
        const dim = hasHover && state.hovered !== it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={(e) => onClick(it.key, e)}
            onMouseEnter={() => onHover(it.key)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(it.key)}
            onBlur={() => onHover(null)}
            aria-pressed={!hidden}
            aria-label={`Toggle series ${it.label ?? it.key}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-transparent text-foreground/85 transition-all duration-150",
              compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]",
              "hover:border-border/70 hover:bg-muted/40 focus:border-border focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
              hidden && "opacity-40 line-through decoration-foreground/40",
              dim && !hidden && "opacity-50",
              "motion-reduce:transition-none",
            )}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
              style={{ backgroundColor: hidden ? "transparent" : it.color, borderColor: it.color, borderWidth: hidden ? 1 : 0, borderStyle: "solid" }}
            />
            <span className="truncate">{it.label ?? it.key}</span>
          </button>
        );
      })}
      {anyHidden && (
        <button
          type="button"
          onClick={onShowAll}
          className={cn(
            "ml-auto inline-flex items-center rounded-md border border-border/70 bg-card text-primary transition-colors hover:bg-muted/40",
            compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]",
          )}
          aria-label="Show all series"
        >
          Show all
        </button>
      )}
    </div>
  );
}

/**
 * Convenience: returns 1 if a series should render fully, dimOpacity if
 * it should fade due to hover-dim, 0 if it's hidden.
 */
export function seriesOpacity(
  key: string,
  state: ChartLegendState,
  dimOpacity = 0.25,
): number {
  if (state.hidden.has(key)) return 0;
  if (state.hovered !== null && state.hovered !== key) return dimOpacity;
  return 1;
}
