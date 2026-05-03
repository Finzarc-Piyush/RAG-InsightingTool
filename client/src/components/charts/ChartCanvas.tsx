/**
 * ChartCanvas — interactive shell wrapping <PremiumChart>. WC2.6.
 *
 * Composes:
 *   - Title + MarkPicker (one-click chart-type switching)
 *   - SuggestedAlts (heuristic-driven, only visible when warranted)
 *   - PremiumChart (the actual renderer)
 *
 * State:
 *   - `mark` (overrides spec.mark when the user picks a different
 *      chart type)
 *   - `encoding` (placeholder — full EncodingShelves drag-and-drop
 *      lands in a later wave; for now, encoding is fixed from spec)
 *
 * Data resolution: for `source.kind === 'session-ref'`, the rows come
 * from `<RawDataProvider>` (WC2.1). For inline source, the spec's
 * own rows are used.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartEncoding, ChartSpecV2, ChartV2Mark } from "@/shared/schema";
import { rowsFromSource, useRawData } from "@/lib/charts/RawDataProvider";
import { applyTransforms } from "@/lib/charts/dataEngine";
import { suggestAlternatives } from "@/lib/charts/suggestedAlts";
import { PremiumChart } from "./PremiumChart";
import { MarkPicker } from "./MarkPicker";
import { SuggestedAlts } from "./SuggestedAlts";
import { ExportMenu } from "./ExportMenu";
import { EncodingShelves } from "./EncodingShelves";

export interface ChartCanvasProps {
  spec: ChartSpecV2;
  /** Fixed height for the chart area. */
  height?: number;
  /** Hide the header (title + mark picker). Useful in ChatChartCard's read-only mode. */
  readonly?: boolean;
  /** Override the title shown in the header. */
  titleOverride?: string;
}

export function ChartCanvas({
  spec,
  height = 320,
  readonly = false,
  titleOverride,
}: ChartCanvasProps) {
  const [markOverride, setMarkOverride] = useState<ChartV2Mark | null>(null);
  const [encodingOverride, setEncodingOverride] = useState<ChartEncoding | null>(null);

  // Fix-4 · reset local overrides when the spec reference changes (new chat
  // answer / pivot config update / fork to explorer with a different spec).
  // Reference identity is the right granularity — the upstream owner
  // recreates spec on each meaningful update.
  useEffect(() => {
    setMarkOverride(null);
    setEncodingOverride(null);
  }, [spec]);
  const effectiveMark: ChartV2Mark = markOverride ?? spec.mark;
  const effectiveEncoding: ChartEncoding = encodingOverride ?? spec.encoding;
  const effectiveSpec = useMemo<ChartSpecV2>(
    () => ({ ...spec, mark: effectiveMark, encoding: effectiveEncoding }),
    [spec, effectiveMark, effectiveEncoding],
  );

  const ctx = useRawData();
  const sourceRows = useMemo(
    () => rowsFromSource(effectiveSpec.source, ctx),
    [effectiveSpec.source, ctx],
  );
  const data = useMemo(
    () => applyTransforms(sourceRows, effectiveSpec.transform),
    [sourceRows, effectiveSpec.transform],
  );

  const suggestions = useMemo(
    () =>
      suggestAlternatives({
        mark: effectiveMark,
        encoding: effectiveSpec.encoding,
        data,
      }),
    [effectiveMark, effectiveSpec.encoding, data],
  );

  const title = titleOverride ?? spec.config?.title?.text;
  const subtitle = spec.config?.title?.subtitle;
  const exportRef = useRef<HTMLDivElement>(null);
  const filenameSlug = (title ?? "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

  return (
    <div className="flex w-full flex-col gap-1.5">
      {!readonly && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {title && (
              <div className="truncate text-sm font-semibold tracking-tight text-foreground">
                {title}
              </div>
            )}
            {subtitle && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {subtitle}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <MarkPicker
              value={effectiveMark}
              encoding={effectiveSpec.encoding}
              onChange={setMarkOverride}
              compact
            />
            <ExportMenu
              containerRef={exportRef}
              data={data}
              filename={filenameSlug}
              compact
            />
          </div>
        </div>
      )}

      {!readonly && (
        <EncodingShelves
          encoding={effectiveEncoding}
          onChange={setEncodingOverride}
          rows={sourceRows}
          compact
        />
      )}

      {!readonly && (
        <SuggestedAlts
          suggestions={suggestions}
          onApply={(mark) => setMarkOverride(mark)}
        />
      )}

      <div ref={exportRef}>
        <PremiumChart spec={effectiveSpec} data={data} height={height} />
      </div>
    </div>
  );
}
