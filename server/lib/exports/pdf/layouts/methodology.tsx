/**
 * W-EXP-9 · Methodology PDF page.
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
  spec: Extract<SlideSpec, { layout: "Methodology" }>;
  ctx: PdfSlideContext;
}

export function MethodologyPage({ spec, ctx }: Props): React.ReactElement {
  const caveats = spec.slots.caveats ?? [];
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Methodology" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, color: PDF_BRAND.foreground, lineHeight: 1.5, marginBottom: 16 }}>
          {spec.slots.body}
        </Text>
        {caveats.length > 0 && (
          <View>
            <Text style={{ fontSize: 11, fontFamily: PDF_FONT_BOLD, color: PDF_BRAND.muted, marginBottom: 6 }}>
              Caveats
            </Text>
            {caveats.map((c, i) => (
              <View key={i} style={{ flexDirection: "row", marginBottom: 4 }}>
                <Text style={{ color: PDF_BRAND.muted, marginRight: 6 }}>○</Text>
                <Text style={{ flex: 1, fontSize: 9, color: PDF_BRAND.muted, lineHeight: 1.4 }}>{c}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
