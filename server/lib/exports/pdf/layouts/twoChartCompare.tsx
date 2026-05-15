/**
 * W-EXP-9 · TwoChartCompare PDF page.
 */
import React from "react";
import { Image, Page, Text, View } from "@react-pdf/renderer";
import { PageFooter, PageHeader, PDF_BRAND, pdfStyles, type PdfSlideContext } from "../master.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { PdfChartDeps } from "./chartWithInsight.js";

interface Props {
  spec: Extract<SlideSpec, { layout: "TwoChartCompare" }>;
  ctx: PdfSlideContext;
  deps: PdfChartDeps;
}

function chartTile(
  chartId: string,
  deps: PdfChartDeps
): React.ReactElement {
  const chart = deps.resolveChart(chartId);
  const svg = chart ? deps.renderSvg(chart, { width: 800, height: 480 }) : null;
  return (
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
        <Text style={{ color: PDF_BRAND.muted, fontSize: 11 }}>Chart unavailable.</Text>
      )}
    </View>
  );
}

export function TwoChartComparePage({ spec, ctx, deps }: Props): React.ReactElement {
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Comparison" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flex: 1, justifyContent: "flex-start" }}>
        <View style={{ flex: 1, flexDirection: "row", gap: 12 }}>
          {chartTile(spec.slots.leftChartId, deps)}
          {chartTile(spec.slots.rightChartId, deps)}
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
