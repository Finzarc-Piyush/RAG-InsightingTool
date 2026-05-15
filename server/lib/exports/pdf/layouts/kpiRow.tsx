/**
 * W-EXP-8 · KpiRow PDF page.
 */
import React from "react";
import { Page, Text, View } from "@react-pdf/renderer";
import {
  PageFooter,
  PageHeader,
  PDF_BRAND,
  PDF_FONT_BOLD,
  pdfStyles,
  type PdfSlideContext,
} from "../master.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

interface Props {
  spec: Extract<SlideSpec, { layout: "KpiRow" }>;
  ctx: PdfSlideContext;
}

function deltaColor(delta: string): string {
  if (/^\s*\+/.test(delta)) return PDF_BRAND.horizonStrategic;
  if (/^\s*[-−]/.test(delta)) return PDF_BRAND.horizonNow;
  return PDF_BRAND.muted;
}

function confidenceColor(conf: "low" | "medium" | "high" | undefined): string {
  if (conf === "high") return PDF_BRAND.primary;
  if (conf === "medium") return PDF_BRAND.accent;
  if (conf === "low") return PDF_BRAND.muted;
  return PDF_BRAND.primary;
}

export function KpiRowPage({ spec, ctx }: Props): React.ReactElement {
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="KPI overview" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flexDirection: "row", flex: 1, gap: 12, marginTop: 12 }}>
        {spec.slots.kpis.map((kpi, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              backgroundColor: PDF_BRAND.surfaceMuted,
              borderRadius: 4,
              borderWidth: 0.5,
              borderColor: PDF_BRAND.border,
              padding: 14,
              flexDirection: "row",
            }}
          >
            <View style={{ width: 4, backgroundColor: confidenceColor(kpi.confidence), borderRadius: 2 }} />
            <View style={{ flex: 1, paddingLeft: 12 }}>
              <Text style={{ fontSize: 10, color: PDF_BRAND.muted, marginBottom: 6 }}>{kpi.label}</Text>
              <Text style={{ fontSize: 28, fontFamily: PDF_FONT_BOLD, color: PDF_BRAND.foreground }}>{kpi.value}</Text>
              {kpi.delta && (
                <Text style={{ fontSize: 11, color: deltaColor(kpi.delta), marginTop: 6 }}>{kpi.delta}</Text>
              )}
            </View>
          </View>
        ))}
      </View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
