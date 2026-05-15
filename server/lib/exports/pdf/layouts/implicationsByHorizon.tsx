/**
 * W-EXP-9 · ImplicationsByHorizon PDF page.
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
  spec: Extract<SlideSpec, { layout: "ImplicationsByHorizon" }>;
  ctx: PdfSlideContext;
}

function Column({ label, color, bullets }: { label: string; color: string; bullets: string[] }): React.ReactElement {
  return (
    <View style={{ flex: 1, marginHorizontal: 6 }}>
      <View style={{ backgroundColor: color, padding: 6, borderRadius: 3, marginBottom: 8, alignItems: "center" }}>
        <Text style={{ color: PDF_BRAND.background, fontFamily: PDF_FONT_BOLD, fontSize: 11 }}>{label}</Text>
      </View>
      <View style={{ flex: 1 }}>
        {bullets.length === 0 ? (
          <Text style={{ color: PDF_BRAND.muted, fontSize: 10, textAlign: "center", marginTop: 8 }}>—</Text>
        ) : (
          bullets.map((b, i) => (
            <View key={i} style={{ flexDirection: "row", marginBottom: 8 }}>
              <View
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: color,
                  marginTop: 5,
                  marginRight: 6,
                }}
              />
              <Text style={{ flex: 1, fontSize: 10, color: PDF_BRAND.foreground, lineHeight: 1.4 }}>{b}</Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

export function ImplicationsByHorizonPage({ spec, ctx }: Props): React.ReactElement {
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Implications by horizon" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flex: 1, flexDirection: "row" }}>
        <Column label="Now" color={PDF_BRAND.horizonNow} bullets={spec.slots.now} />
        <Column label="This quarter" color={PDF_BRAND.horizonThisQuarter} bullets={spec.slots.thisQuarter} />
        <Column label="Strategic" color={PDF_BRAND.horizonStrategic} bullets={spec.slots.strategic} />
      </View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
