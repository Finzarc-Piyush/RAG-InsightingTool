/**
 * W-EXP-8 · ChartWithInsight PDF page.
 *
 * Embeds the chart as an inline ECharts SVG via @react-pdf/renderer's
 * `<Image src=…/>`. @react-pdf >= 4.0 supports SVG via `data:image/svg+xml`
 * URLs; the engine rasterises internally at print resolution.
 *
 * The caller passes a ChartSpec resolver (id → ChartSpec) plus the SVG
 * renderer from `chartSsr.ts` so this layout stays decoupled from the
 * Dashboard model — keeps it unit-testable.
 */
import React from "react";
import { Image, Page, Text, View } from "@react-pdf/renderer";
import { PageFooter, PageHeader, PDF_BRAND, pdfStyles, type PdfSlideContext } from "../master.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { ChartSpec } from "../../../../shared/schema.js";

export interface PdfChartDeps {
  resolveChart: (chartId: string) => ChartSpec | null;
  renderSvg: (spec: ChartSpec, opts: { width: number; height: number }) => string | null;
}

interface Props {
  spec: Extract<SlideSpec, { layout: "ChartWithInsight" }>;
  ctx: PdfSlideContext;
  deps: PdfChartDeps;
}

export function ChartWithInsightPage({ spec, ctx, deps }: Props): React.ReactElement {
  const chart = deps.resolveChart(spec.slots.chartId);
  const svg = chart ? deps.renderSvg(chart, { width: 1024, height: 540 }) : null;
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Finding" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flex: 1, justifyContent: "flex-start" }}>
        <View
          style={{
            flex: 1,
            backgroundColor: PDF_BRAND.surfaceMuted,
            borderWidth: 0.5,
            borderColor: PDF_BRAND.border,
            borderRadius: 4,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          {svg ? (
            <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} style={{ width: "100%", height: "100%" }} />
          ) : (
            <Text style={{ color: PDF_BRAND.muted, fontSize: 12 }}>Chart unavailable for this slide.</Text>
          )}
        </View>
        <Text style={{ fontSize: 12, color: PDF_BRAND.foreground, marginTop: 12, lineHeight: 1.4 }}>
          {spec.slots.insight}
        </Text>
        {spec.slots.source && (
          <Text style={{ fontSize: 8, fontStyle: "italic", color: PDF_BRAND.muted, marginTop: 4 }}>
            {spec.slots.source}
          </Text>
        )}
      </View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
