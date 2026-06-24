import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * The "Show" Top-N / Bottom-N control for bar/column charts that carry more than
 * 10 categories. A native <select> (mode) plus a small number <input> (N) —
 * accessible, and matching the existing "Sort by" toolbar control's style.
 * Stateless: the caller (the fullscreen modals) owns the value.
 *
 * Selection is decoupled from the "Sort by" display order: "Top 10" = the 10
 * largest BY VALUE (shown in whatever order Sort-by dictates); "Bottom 10" = the
 * 10 smallest by value. `null` = show all. Ephemeral (not persisted).
 */

export type ChartLimit = { mode: "top" | "bottom"; n: number } | null;

type Mode = "all" | "top" | "bottom";

const DEFAULT_N = 10;

function clampN(n: number, total: number): number {
  if (!Number.isFinite(n)) return DEFAULT_N;
  const lo = Math.max(1, Math.min(Math.floor(n), Math.max(1, total)));
  return lo;
}

export interface ChartLimitControlProps {
  value: ChartLimit;
  onChange: (next: ChartLimit) => void;
  /** Distinct category count — drives the "All (N)" label + N clamp. */
  total: number;
  className?: string;
}

export function ChartLimitControl({
  value,
  onChange,
  total,
  className,
}: ChartLimitControlProps) {
  const modeId = useId();
  const mode: Mode = value?.mode ?? "all";
  const n = value?.n ?? DEFAULT_N;

  const handleModeChange = (nextMode: Mode) => {
    if (nextMode === "all") {
      onChange(null);
      return;
    }
    onChange({ mode: nextMode, n: clampN(n, total) });
  };

  const handleNChange = (raw: string) => {
    const parsed = Number(raw);
    const effectiveMode: "top" | "bottom" = mode === "all" ? "top" : mode;
    onChange({ mode: effectiveMode, n: clampN(parsed, total) });
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <label
        htmlFor={modeId}
        className="text-[11px] uppercase tracking-wide text-muted-foreground"
      >
        Show
      </label>
      <select
        id={modeId}
        data-testid="chart-limit-control"
        className="rounded border border-border/60 bg-background px-2 py-1 text-xs"
        value={mode}
        onChange={(e) => handleModeChange(e.target.value as Mode)}
      >
        <option value="all">{`All (${total})`}</option>
        <option value="top">Top</option>
        <option value="bottom">Bottom</option>
      </select>
      {mode !== "all" ? (
        <input
          type="number"
          data-testid="chart-limit-n"
          aria-label={mode === "top" ? "Top how many" : "Bottom how many"}
          className="w-16 rounded border border-border/60 bg-background px-2 py-1 text-xs"
          min={1}
          max={total}
          step={1}
          value={n}
          onChange={(e) => handleNChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}
