/**
 * W-EXP-8 · ExecSummary PDF page.
 */
import React from "react";
import { Page, Text, View } from "@react-pdf/renderer";
import { PageFooter, PageHeader, PDF_BRAND, pdfStyles, type PdfSlideContext } from "../master.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

interface Props {
  spec: Extract<SlideSpec, { layout: "ExecSummary" }>;
  ctx: PdfSlideContext;
}

export function ExecSummaryPage({ spec, ctx }: Props): React.ReactElement {
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Executive summary" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flex: 1, justifyContent: "flex-start" }}>
        {spec.slots.bullets.map((b, i) => (
          <View key={i} style={{ flexDirection: "row", marginBottom: 14, alignItems: "flex-start" }}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: PDF_BRAND.primary,
                marginTop: 6,
                marginRight: 12,
              }}
            />
            <Text style={{ fontSize: 14, color: PDF_BRAND.foreground, flex: 1, lineHeight: 1.4 }}>{b}</Text>
          </View>
        ))}
      </View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
