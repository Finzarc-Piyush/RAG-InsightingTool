import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * UX-1 · Brand typography primitives.
 *
 * One component per role so consumers stop hand-setting sizes. Every
 * role is token-driven: the font family comes from `--font-display` /
 * `--font-sans` / `--font-metric`, exposed as Tailwind utilities
 * `font-display`, `font-sans`, `font-metric` (see UX-0 tokens).
 *
 * See docs/brand/brand-guidebook.md §3 for the full scale.
 */

type PolymorphicElement = keyof JSX.IntrinsicElements;

interface BaseProps {
  className?: string;
  children: React.ReactNode;
}

/* ------------------------------------------------------------------ Display */

export interface DisplayProps extends BaseProps {
  /** "xl" — hero H1 (48/52). "lg" — page H1 (36/40). */
  size?: "xl" | "lg";
  as?: PolymorphicElement;
}

/**
 * Display — hero or page H1. Source Serif 4 Medium, negative tracking.
 * Rule from the guidebook: **one display moment per view.**
 */
export function Display({
  size = "lg",
  as: Tag = "h1",
  className,
  children,
}: DisplayProps) {
  const TagEl = Tag as React.ElementType;
  return (
    <TagEl
      className={cn(
        "font-display font-medium text-foreground [font-feature-settings:'ss01','liga']",
        size === "xl"
          ? "text-[48px] leading-[52px] tracking-[-0.02em]"
          : "text-[36px] leading-[40px] tracking-[-0.02em]",
        className
      )}
    >
      {children}
    </TagEl>
  );
}

/* ------------------------------------------------------------------ Heading */

export interface HeadingProps extends BaseProps {
  /** "xl" 28/34 · "lg" 22/28 (card title) · "md" 18/24 (section). */
  size?: "xl" | "lg" | "md";
  as?: PolymorphicElement;
}

/**
 * Heading — Plus Jakarta Sans Semibold, negative tracking graded by size.
 * Use for card titles and section headings; never for hero.
 */
export function Heading({
  size = "lg",
  as: Tag = "h2",
  className,
  children,
}: HeadingProps) {
  const TagEl = Tag as React.ElementType;
  return (
    <TagEl
      className={cn(
        "font-sans font-semibold text-foreground",
        size === "xl" && "text-[28px] leading-[34px] tracking-[-0.015em]",
        size === "lg" && "text-[22px] leading-[28px] tracking-[-0.012em]",
        size === "md" && "text-[18px] leading-[24px] tracking-[-0.008em]",
        className
      )}
    >
      {children}
    </TagEl>
  );
}

/* ------------------------------------------------------------------ Eyebrow */

/**
 * Eyebrow — small caps-style label above a heading. 11/16 Semibold with
 * `0.06em` tracking, muted ink.
 */
export function Eyebrow({ className, children }: BaseProps) {
  return (
    <span
      className={cn(
        "inline-block font-sans text-[11px] leading-4 font-semibold uppercase tracking-[0.06em] text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------- Metric */

export interface MetricProps extends BaseProps {
  /** Optional one-line caption rendered below the number (Caption style). */
  label?: React.ReactNode;
  /** "lg" 28/32 · "md" 22/26 · "sm" 15/20 (inline). */
  size?: "lg" | "md" | "sm";
  as?: PolymorphicElement;
}

/**
 * Metric — tabular numeric display. JetBrains Mono (`font-metric`) with
 * slight negative tracking so the digits read as a single figure.
 */
export function Metric({
  label,
  size = "md",
  as: Tag = "div",
  className,
  children,
}: MetricProps) {
  const TagEl = Tag as React.ElementType;
  return (
    <TagEl
      className={cn(
        "font-metric font-medium text-foreground [font-variant-numeric:tabular-nums] [font-feature-settings:'tnum']",
        size === "lg" && "text-[28px] leading-8 tracking-[-0.01em]",
        size === "md" && "text-[22px] leading-[26px] tracking-[-0.01em]",
        size === "sm" && "text-[15px] leading-5 tracking-[-0.005em]",
        className
      )}
    >
      {children}
      {label ? (
        <span className="mt-1 block font-sans text-[12px] leading-4 font-normal text-muted-foreground tracking-normal">
          {label}
        </span>
      ) : null}
    </TagEl>
  );
}

/* ------------------------------------------------------------------ Caption */

/**
 * Caption — 12/16 muted, default below cards or under metrics. Sans,
 * regular weight.
 */
export function Caption({ className, children }: BaseProps) {
  return (
    <span
      className={cn(
        "font-sans text-[12px] leading-4 text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  );
}
