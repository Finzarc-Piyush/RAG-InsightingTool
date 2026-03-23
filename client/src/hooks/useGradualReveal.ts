import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * Reveals text incrementally for a “typing” effect. When reduced motion is preferred, shows full text immediately.
 */
export function useGradualReveal(
  fullText: string,
  options: {
    /** When false, shows full text immediately. */
    active: boolean;
    charsPerTick?: number;
    intervalMs?: number;
  }
): string {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const { active, charsPerTick = 4, intervalMs = 18 } = options;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!active || prefersReducedMotion) {
      setShown(fullText.length);
      return;
    }

    setShown(0);
    if (!fullText.length) return;

    let n = 0;
    let timeoutId = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      n = Math.min(fullText.length, n + charsPerTick);
      setShown(n);
      if (n < fullText.length) {
        timeoutId = window.setTimeout(tick, intervalMs);
      }
    };
    tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [fullText, active, prefersReducedMotion, charsPerTick, intervalMs]);

  return fullText.slice(0, shown);
}
