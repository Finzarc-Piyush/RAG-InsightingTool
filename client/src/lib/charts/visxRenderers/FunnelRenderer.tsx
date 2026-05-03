/**
 * Visx renderer for the `funnel` mark — descending stages with
 * conversion-% drop labels.
 *
 * Stages are sorted by spec data order (the spec.data is the source
 * of truth for stage order). Bar width is proportional to value;
 * each stage centered horizontally. Drop label between stages shows
 * the conversion % from the previous stage.
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveBarEncoding,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { formatChartValue } from "@/lib/charts/format";

export interface FunnelRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };

export function FunnelRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: FunnelRendererProps) {
  const enc = useMemo(() => resolveBarEncoding(spec), [spec]);
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const stages = useMemo(() => {
    return data
      .map((r) => ({
        label: asString(enc.x.accessor(r)),
        value: asNumber(enc.y.accessor(r)),
      }))
      .filter((s) => Number.isFinite(s.value) && s.value >= 0);
  }, [data, enc]);

  const maxValue = useMemo(
    () => stages.reduce((m, s) => (s.value > m ? s.value : m), 1),
    [stages],
  );

  const stageHeight = stages.length > 0 ? innerHeight / stages.length : 0;
  const stageGap = 4;
  const drawableStageH = Math.max(1, stageHeight - stageGap);

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Funnel chart";

  if (innerWidth <= 0 || innerHeight <= 0 || stages.length === 0) return null;

  return (
    <svg width={width} height={height} role="img" aria-label={accessibleLabel}>
      <Group left={MARGIN.left} top={MARGIN.top}>
        {stages.map((s, i) => {
          const w = (s.value / maxValue) * innerWidth;
          const x = (innerWidth - w) / 2;
          const y = i * stageHeight;
          const fill = qualitativeColor(i);
          const prev = stages[i - 1];
          const drop =
            prev && prev.value > 0
              ? ((prev.value - s.value) / prev.value) * 100
              : null;
          return (
            <g key={`funnel-${i}-${s.label}`}>
              <rect
                x={x}
                y={y}
                width={w}
                height={drawableStageH}
                fill={fill}
                fillOpacity={0.85}
                rx={3}
              />
              <text
                x={innerWidth / 2}
                y={y + drawableStageH / 2 + 4}
                fontSize={12}
                fontFamily="var(--font-sans)"
                fill="hsl(var(--background))"
                fontWeight={600}
                textAnchor="middle"
                pointerEvents="none"
              >
                {s.label} · {formatChartValue(s.value, enc.y.field)}
              </text>
              {drop !== null && (
                <text
                  x={innerWidth / 2}
                  y={y - 2}
                  fontSize={10}
                  fontFamily="var(--font-sans)"
                  fill="hsl(var(--muted-foreground))"
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  ↓ {drop.toFixed(1)}% drop
                </text>
              )}
            </g>
          );
        })}
      </Group>
    </svg>
  );
}
