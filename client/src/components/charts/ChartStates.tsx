/**
 * Chart shell states: skeleton, empty, error. WC1.6.
 *
 * One module, three small components, all using semantic Tailwind tokens
 * and Lucide icons (already a dep). PremiumChart switches between them
 * when `data` is empty / `config.loadingState` is set / a renderer
 * throws.
 */

import { AlertCircle, BarChart3, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChartSkeletonProps {
  height?: number;
  /** Optional progress info: {processed, total, message?}. */
  progress?: { processed: number; total: number; message?: string };
  className?: string;
}

/** Skeleton shown while data is being computed / streamed. */
export function ChartSkeleton({
  height = 280,
  progress,
  className,
}: ChartSkeletonProps) {
  const pct = progress
    ? Math.max(0, Math.min(100, (progress.processed / Math.max(1, progress.total)) * 100))
    : null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading chart"
      className={cn(
        "relative flex w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-lg border border-border/60 bg-muted/20",
        className,
      )}
      style={{ height }}
    >
      {/* Subtle pulsing tint indicating activity. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 animate-pulse bg-foreground/[0.025] motion-reduce:animate-none"
      />
      <Loader2
        className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none"
        aria-hidden
      />
      {progress ? (
        <div className="flex flex-col items-center gap-1.5">
          <div className="text-[11px] font-medium text-foreground/80">
            {progress.message ?? "Computing chart data"}
          </div>
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-200 motion-reduce:transition-none"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="text-[10px] tabular-nums text-muted-foreground">
            {progress.processed.toLocaleString()} / {progress.total.toLocaleString()}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">Rendering chart…</div>
      )}
    </div>
  );
}

export interface ChartEmptyProps {
  height?: number;
  /** Top-line message; defaults to "No data to display". */
  title?: string;
  /** Sub-line; defaults to a generic CTA. */
  description?: string;
  /** Optional inline action (button / link). */
  action?: React.ReactNode;
  className?: string;
}

/** Empty state when data length is 0 or the encoding produces no rows. */
export function ChartEmpty({
  height = 280,
  title = "No data to display",
  description = "Try adjusting filters or selecting different dimensions.",
  action,
  className,
}: ChartEmptyProps) {
  return (
    <div
      role="img"
      aria-label={title}
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/80 bg-muted/10 p-6 text-center",
        className,
      )}
      style={{ height }}
    >
      <BarChart3
        className="h-8 w-8 text-muted-foreground/60"
        strokeWidth={1.5}
        aria-hidden
      />
      <div className="text-sm font-medium text-foreground/80">{title}</div>
      <div className="max-w-[260px] text-xs text-muted-foreground">
        {description}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export interface ChartErrorProps {
  height?: number;
  /** The error to display. Plain Error or string. */
  error: unknown;
  /** Optional retry callback; renders a Try Again button when set. */
  onRetry?: () => void;
  className?: string;
}

/** Error state rendered by the PremiumChart error boundary. */
export function ChartError({
  height = 280,
  error,
  onRetry,
  className,
}: ChartErrorProps) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown rendering error";
  return (
    <div
      role="alert"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center",
        className,
      )}
      style={{ height }}
    >
      <AlertCircle
        className="h-7 w-7 text-destructive"
        strokeWidth={1.5}
        aria-hidden
      />
      <div className="text-sm font-medium text-foreground">
        Couldn't render this chart
      </div>
      <div className="max-w-[320px] break-words text-xs text-muted-foreground">
        {message}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex items-center rounded-md border border-border/80 bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
        >
          Try again
        </button>
      )}
    </div>
  );
}
