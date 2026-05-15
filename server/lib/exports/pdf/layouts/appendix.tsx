/**
 * W-EXP-9 · Appendix PDF page. Catch-all for supporting material — chart,
 * table, or body of supplementary text. Top-right "APPENDIX" tag so the
 * executive reader knows to skim.
 */
import React from "react";
import { Image, Page, Text, View } from "@react-pdf/renderer";
import {
  PageFooter,
  PageHeader,
  PDF_BRAND,
  PDF_FONT_BOLD,
  pdfStyles,
  type PdfSlideContext,
} from "../master.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { PdfChartDeps } from "./chartWithInsight.js";
import type { PdfTableDeps } from "./tableSlide.js";

interface Props {
  spec: Extract<SlideSpec, { layout: "Appendix" }>;
  ctx: PdfSlideContext;
  deps: PdfChartDeps & PdfTableDeps;
}

export function AppendixPage({ spec, ctx, deps }: Props): React.ReactElement {
  let body: React.ReactElement | null = null;

  if (spec.slots.chartId) {
    const chart = deps.resolveChart(spec.slots.chartId);
    const svg = chart ? deps.renderSvg(chart, { width: 1024, height: 540 }) : null;
    body = svg ? (
      <Image src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} style={{ width: "100%", height: "100%" }} />
    ) : (
      <Text style={{ color: PDF_BRAND.muted, fontSize: 12 }}>Chart unavailable.</Text>
    );
  } else if (spec.slots.tableId) {
    const table = deps.resolveTable(spec.slots.tableId);
    body = table ? (
      <View>
        <View style={{ flexDirection: "row", backgroundColor: PDF_BRAND.muted, padding: 4 }}>
          {table.columns.map((col, i) => (
            <Text
              key={i}
              style={{ flex: 1, color: PDF_BRAND.background, fontFamily: PDF_FONT_BOLD, fontSize: 8 }}
            >
              {col}
            </Text>
          ))}
        </View>
        {table.rows.slice(0, 80).map((row, ri) => (
          <View
            key={ri}
            style={{
              flexDirection: "row",
              backgroundColor: ri % 2 === 0 ? PDF_BRAND.background : PDF_BRAND.surfaceMuted,
              padding: 3,
              borderBottomWidth: 0.25,
              borderBottomColor: PDF_BRAND.border,
            }}
          >
            {row.map((cell, ci) => (
              <Text
                key={ci}
                style={{
                  flex: 1,
                  fontSize: 8,
                  color: PDF_BRAND.foreground,
                  textAlign: typeof cell === "number" ? "right" : "left",
                  paddingRight: 6,
                }}
              >
                {cell == null ? "" : String(cell)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    ) : (
      <Text style={{ color: PDF_BRAND.muted, fontSize: 12 }}>Table unavailable.</Text>
    );
  } else if (spec.slots.body) {
    body = (
      <Text style={{ fontSize: 10, color: PDF_BRAND.foreground, lineHeight: 1.4 }}>{spec.slots.body}</Text>
    );
  }

  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="APPENDIX" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flex: 1 }}>{body}</View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
