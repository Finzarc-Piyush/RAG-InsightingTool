import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export type AppLoadingScreenProps = {
  /** Shown below the spinner */
  message?: string;
  /** Use inside Layout (below header); default is full viewport (auth gates). */
  variant?: "fullscreen" | "embedded";
  className?: string;
};

export function AppLoadingScreen({
  message = "Loading…",
  variant = "fullscreen",
  className,
}: AppLoadingScreenProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center bg-background",
        variant === "fullscreen" && "min-h-screen w-full",
        variant === "embedded" &&
          "min-h-[calc(100vh-4.25rem)] w-full bg-gradient-to-b from-muted/30 to-background",
        className
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="relative flex flex-col items-center gap-5 px-6 text-center">
        <div
          className="pointer-events-none absolute inset-0 -m-24 rounded-full bg-primary/5 blur-3xl motion-reduce:opacity-0"
          aria-hidden
        />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-border/80 bg-card shadow-sm">
          <Loader2
            className="h-7 w-7 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden
          />
        </div>
        <p className="relative max-w-sm text-sm font-medium text-muted-foreground tracking-tight">
          {message}
        </p>
      </div>
    </div>
  );
}
