import * as React from "react";
import {
  motion,
  useReducedMotion,
  type HTMLMotionProps,
  type Transition,
} from "framer-motion";

import { cn } from "@/lib/utils";

/**
 * UX-1 · Motion primitives.
 *
 * One toolkit, one opinionated motion language. Every primitive short-
 * circuits when `prefers-reduced-motion: reduce` is set (via framer-motion's
 * `useReducedMotion`). See docs/brand/brand-guidebook.md §6.
 *
 * - Settle   — first-mount entry: opacity 0→1, translateY 8px→0.
 * - Stagger  — wraps children with sequenced Settle delays.
 * - Breathe  — subtle pulse for streaming / "still working" states.
 * - Shimmer  — loading skeleton sweep.
 *
 * Timings + easings come from the UX-0 tokens
 * (`--duration-*` and `--ease-*` in client/src/index.css).
 */

const EASE_ENTRANCE: Transition["ease"] = [0.16, 1, 0.3, 1];
const DURATION_BASE = 0.22;
const DURATION_SLOW = 0.32;

/** Entry-on-mount wrapper. Motion-reduced users get the final state immediately. */
export interface SettleProps extends HTMLMotionProps<"div"> {
  /** Stagger offset from a parent `<Stagger>` — consumers typically leave unset. */
  delayMs?: number;
  /** When false (e.g. re-rendering a live list), skip the animation. */
  animate?: boolean;
  className?: string;
}

export const Settle = React.forwardRef<HTMLDivElement, SettleProps>(
  ({ children, className, delayMs = 0, animate = true, ...rest }, ref) => {
    const reduce = useReducedMotion();
    if (reduce || !animate) {
      return (
        <div ref={ref} className={className}>
          {children}
        </div>
      );
    }
    return (
      <motion.div
        ref={ref}
        className={className}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: DURATION_SLOW,
          ease: EASE_ENTRANCE,
          delay: delayMs / 1000,
        }}
        {...rest}
      >
        {children}
      </motion.div>
    );
  }
);
Settle.displayName = "Settle";

/**
 * Wraps its direct children so each appears with a `Settle` effect
 * staggered by `stepMs`. Children MUST be keyed React nodes for the
 * ordering to stay stable.
 */
export interface StaggerProps {
  children: React.ReactNode;
  /** Offset between children. Default 60ms. */
  stepMs?: number;
  /** Offset applied to the first child, too. Default 0. */
  leadMs?: number;
  className?: string;
}

export function Stagger({
  children,
  stepMs = 60,
  leadMs = 0,
  className,
}: StaggerProps) {
  const childArray = React.Children.toArray(children);
  return (
    <div className={className}>
      {childArray.map((child, idx) => (
        <Settle
          key={(child as React.ReactElement).key ?? idx}
          delayMs={leadMs + idx * stepMs}
        >
          {child}
        </Settle>
      ))}
    </div>
  );
}

/**
 * Breathe — subtle 1800ms pulse for "still working" / streaming indicators.
 * Pairs the `brand-breathe` keyframe utility with motion-reduced support.
 */
export interface BreatheProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** When false, render a static child (useful when the stream completes). */
  active?: boolean;
}

export function Breathe({
  children,
  active = true,
  className,
  ...rest
}: BreatheProps) {
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex items-center",
        active ? "animate-brand-breathe" : undefined,
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * Shimmer — loading skeleton with the `brand-shimmer` keyframe. Accepts
 * children so consumers can layer content on top (e.g. a chart axis
 * outline). Respects reduced motion via the global CSS guard in index.css.
 */
export interface ShimmerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** When false, renders without the shimmer animation (use for empty states). */
  active?: boolean;
}

export function Shimmer({
  children,
  active = true,
  className,
  style,
  ...rest
}: ShimmerProps) {
  return (
    <div
      {...rest}
      className={cn(
        "overflow-hidden bg-muted/50",
        active ? "animate-brand-shimmer" : undefined,
        className
      )}
      style={{
        ...style,
        // Gradient sweep that animates via background-position (keyframe in tailwind).
        backgroundImage: active
          ? "linear-gradient(110deg, transparent 40%, hsl(var(--muted-foreground) / 0.08) 50%, transparent 60%)"
          : undefined,
        backgroundSize: active ? "200% 100%" : undefined,
      }}
    >
      {children}
    </div>
  );
}
