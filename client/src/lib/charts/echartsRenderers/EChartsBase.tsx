/**
 * EChartsBase — shared shell for every lazy-loaded ECharts mark.
 *
 * Holds an ECharts instance bound to a div ref. Re-applies options on
 * spec/data changes. Theme bridge: reads CSS variables on mount and
 * passes them as ECharts theme options. Listens for `prefers-color-scheme`
 * changes to dispose + re-init when light/dark switches (since ECharts
 * theme is read at init).
 *
 * ECharts is dynamically imported so it doesn't ship in the main
 * bundle. Each specialty mark imports just the chart type it needs.
 */

import { useEffect, useRef } from "react";

export type EChartsType = typeof import("echarts");

export interface EChartsBaseProps {
  /** Build the ECharts options from props. */
  buildOptions: (echarts: EChartsType, theme: ChartTheme) => unknown;
  /** Cache key — recomputes options when this changes. */
  optionsKey: unknown;
  width: number;
  height: number;
  ariaLabel?: string;
}

export interface ChartTheme {
  background: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  /** chart-1..12 resolved CSS values. */
  qualitative: string[];
  /** chart-seq-1..9 resolved CSS values. */
  sequential: string[];
  /** chart-div-1..11 resolved CSS values. */
  diverging: string[];
}

function resolveCssVar(name: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return "";
  }
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v ? `hsl(${v})` : "";
}

function readChartTheme(): ChartTheme {
  return {
    background: resolveCssVar("--background"),
    foreground: resolveCssVar("--foreground"),
    mutedForeground: resolveCssVar("--muted-foreground"),
    border: resolveCssVar("--border"),
    qualitative: Array.from({ length: 12 }, (_, i) =>
      resolveCssVar(`--chart-${i + 1}`),
    ),
    sequential: Array.from({ length: 9 }, (_, i) =>
      resolveCssVar(`--chart-seq-${i + 1}`),
    ),
    diverging: Array.from({ length: 11 }, (_, i) =>
      resolveCssVar(`--chart-div-${i + 1}`),
    ),
  };
}

export function EChartsBase({
  buildOptions,
  optionsKey,
  width,
  height,
  ariaLabel,
}: EChartsBaseProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<{
    instance: ReturnType<EChartsType["init"]> | null;
  }>({ instance: null });

  // Mount + theme observer.
  useEffect(() => {
    let cancelled = false;
    let echartsRef: EChartsType | null = null;

    async function init() {
      const echarts = (await import("echarts")) as unknown as EChartsType;
      if (cancelled || !containerRef.current) return;
      echartsRef = echarts;
      const theme = readChartTheme();
      const inst = echarts.init(containerRef.current, undefined, {
        renderer: "canvas",
        width,
        height,
      });
      chartRef.current.instance = inst;
      inst.setOption(buildOptions(echarts, theme) as never);
    }
    void init();

    // Re-apply theme when either the OS scheme OR the app-level theme
    // toggles (next-themes adds/removes `class="dark"` on <html>; this
    // doesn't fire prefers-color-scheme, so we MutationObserver the
    // <html> class attribute as the primary signal — Fix-3).
    const reapplyTheme = () => {
      if (!chartRef.current.instance || !echartsRef) return;
      const theme = readChartTheme();
      chartRef.current.instance.setOption(
        buildOptions(echartsRef, theme) as never,
        true,
      );
    };

    const mql =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    mql?.addEventListener?.("change", reapplyTheme);

    let mo: MutationObserver | null = null;
    if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
      mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === "attributes" && m.attributeName === "class") {
            reapplyTheme();
            break;
          }
        }
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    return () => {
      cancelled = true;
      mql?.removeEventListener?.("change", reapplyTheme);
      mo?.disconnect();
      chartRef.current.instance?.dispose();
      chartRef.current.instance = null;
    };
    // We intentionally re-init only on mount; option updates run separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize when width/height change.
  useEffect(() => {
    const inst = chartRef.current.instance;
    if (!inst) return;
    inst.resize({ width, height });
  }, [width, height]);

  // Re-apply options when key changes.
  useEffect(() => {
    let cancelled = false;
    async function update() {
      const inst = chartRef.current.instance;
      if (!inst) return;
      const echarts = (await import("echarts")) as unknown as EChartsType;
      if (cancelled) return;
      const theme = readChartTheme();
      inst.setOption(buildOptions(echarts, theme) as never, false);
    }
    void update();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      style={{ width, height }}
    />
  );
}
