# Convention: hover-time vertical cross-hair indicator on brush-capable visx trend renderers

> Introduced in Wave WHov-line-crosshair (2026-05-22), promoted on second instance in Wave WHov-area-crosshair (2026-05-25). See `docs/WAVES.md` for the original context.

## Rule

Every brush-capable visx trend renderer (LineRenderer, AreaRenderer, and any future temporal/categorical visx renderer that supports brush mechanics) MUST render a vertical cross-hair `<line>` at the snapped nearest-x position during hover, gated on `tooltipOpen && tooltipData && brushStart === null`.

## Why

Users hovering over a trend chart need a visual anchor showing WHICH x-bucket the tooltip values correspond to. Without the cross-hair, users must mentally project from the tooltip title down to the x-axis — a cognitive shortcut that every financial-chart user expects to skip. The indicator also establishes that the tooltip snaps to discrete data points (not the raw cursor x), which prevents users from thinking interpolated values exist at arbitrary cursor positions.

## How to apply

When adding a new brush-capable visx trend renderer (or retrofitting an existing one with hover):

1. Ensure the renderer has `useTooltip<{ xRaw: unknown; ... }>()` with a nearest-x snap in its `onMouseMove` handler.
2. Add the cross-hair block after the brush rectangle, before the data lines (UNDER the data for standard layering):
   ```tsx
   {tooltipOpen && tooltipData && brushStart === null && (() => {
     const cx = xPx(tooltipData.xRaw);
     if (!Number.isFinite(cx)) return null;
     return (
       <line
         x1={cx} x2={cx} y1={0} y2={innerHeight}
         stroke="hsl(var(--muted-foreground))"
         strokeOpacity={0.45}
         strokeDasharray="3 3"
         strokeWidth={1}
         pointerEvents="none"
       />
     );
   })()}
   ```
3. Pin with source-inspection tests: snap binding (`xPx(tooltipData.xRaw)` not raw cursor), conjunction guard, pointerEvents, dashed stroke, NaN guard.
4. Mark with `Wave WHov-<renderer>-crosshair ·` comment for greppable lineage.

Key invariants:
- **Snap binding**: `xPx(tooltipData.xRaw)` — NEVER `tooltipLeft` or raw cursor pixel.
- **Brush exclusion**: `brushStart === null` — brush rectangle owns the visual during drag.
- **Layering**: rendered UNDER data lines/areas so series strokes pass OVER the indicator.
- **Style**: dashed, muted, low-opacity — hint not divider.

## Related

- [Wave WHov-line-crosshair entry](../WAVES.md) — first instance (LineRenderer)
- [Wave WHov-area-crosshair entry](../WAVES.md) — second instance (AreaRenderer), promotion trigger
- Files: [`LineRenderer.tsx`](../../client/src/lib/charts/visxRenderers/LineRenderer.tsx), [`AreaRenderer.tsx`](../../client/src/lib/charts/visxRenderers/AreaRenderer.tsx)
