import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Observe an element's content-box width in px. Returns `[ref, width]`.
 *
 * `width` is `0` until the first ResizeObserver callback (or when
 * `ResizeObserver` is unavailable, e.g. SSR / old test envs) — callers should
 * treat `0` as "unknown" and fall back to a width-agnostic default. Thin DOM
 * glue (precedent: `useTileAutoFit`); the layout math that consumes the width
 * lives in pure helpers (e.g. `maxXAxisLabels`), so this hook needs no test.
 *
 * Used by the recharts chart surfaces (chat card + modals) to size their
 * x-axis label budget to the actual rendered width instead of a fixed cap.
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): [
  React.RefObject<T>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  // useLayoutEffect (not useEffect): the priming `clientWidth` read below runs
  // synchronously after DOM mutation but BEFORE the browser paints, so the very
  // first painted frame already has the real width — no one-frame flash at the
  // width-unknown fallback budget (e.g. the old "stuck at 10 labels"). SSR-safe:
  // returns early when ResizeObserver/DOM is absent, and these chart surfaces
  // are client-only.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const apply = (w: number) => {
      if (w > 0) {
        // Ignore sub-pixel jitter so we don't thrash the tick memos.
        setWidth((prev) => (Math.abs(prev - w) >= 1 ? w : prev));
      }
    };

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        apply(entry.contentRect?.width ?? el.clientWidth);
      }
    });
    ro.observe(el);
    // Prime once — ResizeObserver fires async, so the first paint would
    // otherwise keep the fallback budget for a frame.
    apply(el.clientWidth);

    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
