/**
 * W10 · StreamingIndicator
 *
 * Lightweight elapsed-time chip rendered on the in-flight assistant bubble.
 * Solves the "is it stuck?" question on long correlation / multi-step turns
 * by giving the user a visible, second-by-second progress signal.
 *
 * Self-contained timer — starts on mount, ticks every second, stops on unmount
 * or when `running` flips false. No prop callbacks, no parent state.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

interface StreamingIndicatorProps {
  running: boolean;
  /** Optional one-line label of the current step (e.g. "Reflecting…"). */
  label?: string;
  /**
   * Override the start time — defaults to the moment this component mounts.
   * Useful when the parent already has a timestamp (e.g. SSE message epoch).
   */
  startedAt?: number;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function StreamingIndicator({
  running,
  label,
  startedAt,
}: StreamingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const start = startedAt ?? Date.now();
    setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);

  if (!running) return null;

  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/30 px-3 py-1 text-[12px] text-muted-foreground"
      role="status"
      aria-live="polite"
      aria-label={`Analysis in progress, ${formatElapsed(elapsed)} elapsed${
        label ? `, current step: ${label}` : ""
      }`}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      <span className="tabular-nums font-medium text-foreground">
        {formatElapsed(elapsed)}
      </span>
      {label && (
        <span className="max-w-[200px] truncate" title={label}>
          {label}
        </span>
      )}
    </div>
  );
}
