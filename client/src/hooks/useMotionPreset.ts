import { useMemo } from "react";
import {
  useReducedMotion,
  type Transition,
  type Variants,
} from "framer-motion";

/**
 * UX-1 · Shared motion presets keyed to the brand easings/durations
 * declared in `client/src/index.css` (UX-0 tokens).
 *
 * Usage:
 *   const presets = useMotionPreset();
 *   <motion.div initial={presets.enter.initial}
 *               animate={presets.enter.animate}
 *               transition={presets.enter.transition}>
 *
 * Every preset becomes a no-op when the user prefers reduced motion —
 * `initial` flips to match `animate` so nothing flickers.
 *
 * See docs/brand/brand-guidebook.md §6.
 */

const EASE_ENTRANCE: Transition["ease"] = [0.16, 1, 0.3, 1];
const EASE_EXIT: Transition["ease"] = [0.7, 0, 0.84, 0];
const EASE_STANDARD: Transition["ease"] = [0.4, 0, 0.2, 1];
const EASE_EMPHASIZED: Transition["ease"] = [0.2, 0, 0, 1];

const DURATION_QUICK = 0.16;
const DURATION_BASE = 0.22;
const DURATION_SLOW = 0.32;

export interface MotionPresetBundle {
  /** Default entrance for cards, tiles, list rows. */
  enter: {
    initial: { opacity: number; y: number };
    animate: { opacity: number; y: number };
    transition: Transition;
  };
  /** Decisive exit paired with `enter`. */
  exit: {
    initial: { opacity: number; y: number };
    animate: { opacity: number; y: number };
    transition: Transition;
  };
  /** Resting → hover lift for interactive cards and dashboard tiles. */
  lift: {
    whileHover: { y: number; boxShadow: string };
    whileTap: { y: number };
    transition: Transition;
  };
  /** Soft spring for delight moments (CTA confirm, first chart render). */
  springSoft: Transition;
  /** Staggered-list container + item variants. */
  list: {
    container: Variants;
    item: Variants;
  };
  /** True when the user has asked us to hold the motion. */
  reducedMotion: boolean;
}

export function useMotionPreset(): MotionPresetBundle {
  const reduce = useReducedMotion() ?? false;

  return useMemo<MotionPresetBundle>(() => {
    if (reduce) {
      const staticEnter = {
        initial: { opacity: 1, y: 0 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0 } as Transition,
      };
      return {
        enter: staticEnter,
        exit: staticEnter,
        lift: {
          whileHover: { y: 0, boxShadow: "var(--shadow-sm)" },
          whileTap: { y: 0 },
          transition: { duration: 0 } as Transition,
        },
        springSoft: { duration: 0 } as Transition,
        list: {
          container: { hidden: {}, show: {} },
          item: { hidden: {}, show: {} },
        },
        reducedMotion: true,
      };
    }

    return {
      enter: {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: DURATION_SLOW, ease: EASE_ENTRANCE },
      },
      exit: {
        initial: { opacity: 1, y: 0 },
        animate: { opacity: 0, y: -4 },
        transition: { duration: DURATION_QUICK, ease: EASE_EXIT },
      },
      lift: {
        whileHover: { y: -2, boxShadow: "var(--shadow-md)" },
        whileTap: { y: 0 },
        transition: { duration: DURATION_BASE, ease: EASE_STANDARD },
      },
      springSoft: {
        type: "spring",
        stiffness: 260,
        damping: 28,
        mass: 0.8,
      },
      list: {
        container: {
          hidden: { opacity: 0 },
          show: {
            opacity: 1,
            transition: {
              staggerChildren: 0.06,
              delayChildren: 0.05,
              when: "beforeChildren",
            },
          },
        },
        item: {
          hidden: { opacity: 0, y: 8 },
          show: {
            opacity: 1,
            y: 0,
            transition: { duration: DURATION_BASE, ease: EASE_ENTRANCE },
          },
        },
      },
      reducedMotion: false,
    };
  }, [reduce]);
}

/** Re-exports for consumers that want the raw constants (charts, etc.). */
export const motionTokens = {
  EASE_ENTRANCE,
  EASE_EXIT,
  EASE_STANDARD,
  EASE_EMPHASIZED,
  DURATION_QUICK,
  DURATION_BASE,
  DURATION_SLOW,
};
