/**
 * Subtle "still working" indicator placed just above the chat composer when
 * a turn is in flight. Matches the muted, monochrome design language of the
 * thinking strip — a single accent asterisk plus a quiet "Percolating…"
 * label whose dots wave to signal liveness without competing with the
 * thinking panel above.
 */

export function PercolatingIndicator() {
  return (
    <div
      className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground"
      aria-live="polite"
      role="status"
    >
      <span
        aria-hidden="true"
        className="text-primary text-base leading-none animate-pulse"
        style={{ animationDuration: "1.6s" }}
      >
        *
      </span>
      <span className="font-medium tracking-tight">
        Percolating
        <span className="inline-flex">
          <span
            className="animate-pulse"
            style={{ animationDuration: "1.4s", animationDelay: "0ms" }}
          >
            .
          </span>
          <span
            className="animate-pulse"
            style={{ animationDuration: "1.4s", animationDelay: "200ms" }}
          >
            .
          </span>
          <span
            className="animate-pulse"
            style={{ animationDuration: "1.4s", animationDelay: "400ms" }}
          >
            .
          </span>
        </span>
      </span>
    </div>
  );
}
