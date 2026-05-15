/**
 * W-EXP-9 · Recommendations PDF page.
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

const HORIZON_COLOR: Record<"now" | "this_quarter" | "strategic", string> = {
  now: PDF_BRAND.horizonNow,
  this_quarter: PDF_BRAND.horizonThisQuarter,
  strategic: PDF_BRAND.horizonStrategic,
};

const HORIZON_LABEL: Record<"now" | "this_quarter" | "strategic", string> = {
  now: "Now",
  this_quarter: "This quarter",
  strategic: "Strategic",
};

interface Props {
  spec: Extract<SlideSpec, { layout: "Recommendations" }>;
  ctx: PdfSlideContext;
}

export function RecommendationsPage({ spec, ctx }: Props): React.ReactElement {
  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Recommendations" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      <View style={{ flex: 1 }}>
        {spec.slots.items.map((item, i) => (
          <View
            key={i}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              marginBottom: 14,
              borderLeftWidth: 3,
              borderLeftColor: HORIZON_COLOR[item.horizon],
              paddingLeft: 10,
            }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: PDF_BRAND.primary,
                justifyContent: "center",
                alignItems: "center",
                marginRight: 10,
              }}
            >
              <Text style={{ color: PDF_BRAND.background, fontFamily: PDF_FONT_BOLD, fontSize: 10 }}>{i + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontFamily: PDF_FONT_BOLD, color: PDF_BRAND.foreground }}>
                {item.action}
              </Text>
              <Text style={{ fontSize: 10, color: PDF_BRAND.muted, marginTop: 4, lineHeight: 1.4 }}>
                {item.rationale}
              </Text>
            </View>
            <View style={{ width: 110, alignItems: "flex-end" }}>
              <View
                style={{
                  backgroundColor: HORIZON_COLOR[item.horizon],
                  paddingHorizontal: 10,
                  paddingVertical: 3,
                  borderRadius: 10,
                }}
              >
                <Text style={{ color: PDF_BRAND.background, fontFamily: PDF_FONT_BOLD, fontSize: 9 }}>
                  {HORIZON_LABEL[item.horizon]}
                </Text>
              </View>
              {(item.owner || item.confidence) && (
                <Text style={{ fontSize: 8, color: PDF_BRAND.muted, marginTop: 4, textAlign: "right" }}>
                  {[item.owner, item.confidence ? `${item.confidence} confidence` : null].filter(Boolean).join(" · ")}
                </Text>
              )}
            </View>
          </View>
        ))}
      </View>
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
