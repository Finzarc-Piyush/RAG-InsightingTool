/**
 * Shared "thinking pulse" presentation — the animated sparkles icon + a single
 * large, cross-fading status line. Extracted from DatasetEnrichmentLoader so the
 * dataset-enrichment loader and the live chat ThinkingPanel render the SAME
 * lively centerpiece instead of drifting copies. Purely presentational and
 * effect-free apart from reduced-motion detection: the caller owns rotation
 * timing and passes the line to show right now (`line`).
 *
 * Exports three pieces so each surface can compose what it needs:
 *  - ThinkingPulseIcon — the animated icon stack alone.
 *  - RotatingLine      — the cross-fading line alone (color via className).
 *  - ThinkingPulse     — icon + line as one flex row (used by the chat header).
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export type PulseSize = "lg" | "sm";

const SIZES: Record<PulseSize, { box: string; spark: string; orbit: string; line: string; minH: string }> = {
  lg: {
    box: "h-14 w-14 sm:h-16 sm:w-16",
    spark: "h-6 w-6 sm:h-7 sm:w-7",
    orbit: "-translate-y-[22px] sm:-translate-y-[26px]",
    line: "text-sm",
    minH: "min-h-[2.5rem]",
  },
  sm: {
    box: "h-9 w-9",
    spark: "h-4 w-4",
    orbit: "-translate-y-[14px]",
    line: "text-xs",
    minH: "min-h-[1.5rem]",
  },
};

/**
 * Honors `prefers-reduced-motion` without depending on framer-motion's
 * `useReducedMotion` (which touches `window.matchMedia` unguarded — absent in
 * jsdom). Mirrors the guarded matchMedia pattern used elsewhere in the app.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export function ThinkingPulseIcon({ size = "lg", className }: { size?: PulseSize; className?: string }) {
  const reduce = usePrefersReducedMotion();
  const s = SIZES[size];
  return (
    <div className={cn("relative flex shrink-0 items-center justify-center", s.box, className)}>
      {reduce ? (
        <div className="absolute inset-0 rounded-full border border-primary/20 bg-primary/[0.07]" />
      ) : (
        <>
          <motion.div
            className="absolute inset-0 rounded-full border border-primary/20 bg-primary/[0.07]"
            animate={{ scale: [1, 1.06, 1], opacity: [0.85, 1, 0.85] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute inset-1 rounded-full border border-primary/10"
            style={{ borderStyle: "dashed" }}
            animate={{ rotate: 360 }}
            transition={{ duration: 28, repeat: Infinity, ease: "linear" }}
          />
          <motion.div
            className="absolute inset-0 flex items-center justify-center"
            animate={{ rotate: 360 }}
            transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
          >
            <div
              className={cn(
                "h-2 w-2 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.55)]",
                s.orbit
              )}
            />
          </motion.div>
        </>
      )}
      <Sparkles className={cn("relative z-10 text-primary/90", s.spark)} strokeWidth={1.25} />
    </div>
  );
}

export function RotatingLine({
  line,
  size = "lg",
  className,
}: {
  line: string;
  size?: PulseSize;
  className?: string;
}) {
  const reduce = usePrefersReducedMotion();
  const s = SIZES[size];
  return (
    <div className={cn("relative leading-relaxed", s.minH, s.line, className)}>
      <AnimatePresence mode="wait">
        <motion.p
          key={line}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          transition={{ duration: 0.35 }}
          className="text-pretty"
        >
          {line}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

export interface ThinkingPulseProps {
  /** The line to show right now — the caller owns rotation timing. */
  line: string;
  size?: PulseSize;
  className?: string;
  /** Tailwind text-color class for the line (defaults to muted). */
  lineClassName?: string;
}

export function ThinkingPulse({ line, size = "lg", className, lineClassName }: ThinkingPulseProps) {
  return (
    <div className={cn("flex items-center gap-3 sm:gap-4", className)}>
      <ThinkingPulseIcon size={size} />
      <div className="min-w-0 flex-1">
        <RotatingLine line={line} size={size} className={cn("text-muted-foreground", lineClassName)} />
      </div>
    </div>
  );
}
