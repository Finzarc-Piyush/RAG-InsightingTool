/**
 * W-EXP-8 · TitleSlide PDF page.
 */
import React from "react";
import { Page, Text, View } from "@react-pdf/renderer";
import {
  PDF_BRAND,
  PDF_FONT_BOLD,
  PageFooter,
  PageHeader,
  pdfStyles,
  type PdfSlideContext,
} from "../master.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

interface Props {
  spec: Extract<SlideSpec, { layout: "TitleSlide" }>;
  ctx: PdfSlideContext & { deckTitle: string; deckSubtitle?: string; preparedFor?: string };
}

export function TitleSlidePage({ spec, ctx }: Props): React.ReactElement {
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Cover" />
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 8, backgroundColor: PDF_BRAND.primary }} />
      <View style={{ flex: 1, justifyContent: "center", paddingLeft: 30, paddingRight: 60 }}>
        <Text style={{ fontSize: 32, fontFamily: PDF_FONT_BOLD, color: PDF_BRAND.foreground, marginBottom: 8 }}>
          {ctx.deckTitle}
        </Text>
        <View style={{ width: 80, height: 3, backgroundColor: PDF_BRAND.primary, marginBottom: 12 }} />
        <Text style={{ fontSize: 16, color: PDF_BRAND.muted, marginBottom: 32 }}>
          {spec.slots.subtitle ?? ctx.deckSubtitle ?? spec.actionTitle}
        </Text>
        <View style={{ flexDirection: "column", marginTop: 60 }}>
          {(spec.slots.preparedFor ?? ctx.preparedFor) && (
            <Text style={pdfStyles.mutedText}>{`Prepared for: ${spec.slots.preparedFor ?? ctx.preparedFor}`}</Text>
          )}
          <Text style={pdfStyles.mutedText}>{`Generated: ${ctx.generatedAt}`}</Text>
          <Text style={pdfStyles.mutedText}>{spec.slots.confidentiality ?? ctx.confidentiality}</Text>
        </View>
      </View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
