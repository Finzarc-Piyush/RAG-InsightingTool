/**
 * W-EXP-8 · @react-pdf master — palette, page setup, running header/footer.
 *
 * @react-pdf/renderer is a pure server-side React renderer that produces a
 * PDF Buffer with no Chromium / Puppeteer / system fonts. It uses a
 * subset of CSS (`StyleSheet.create({...})`) and provides primitives
 * `<Document>`, `<Page>`, `<View>`, `<Text>`, `<Image>`, `<Svg>`.
 *
 * Layout primitives are sized in pt (1pt = 1/72 inch). Letter landscape
 * (792 × 612 pt) gives us a 16:9-friendly canvas symmetric to the PPT
 * `LAYOUT_WIDE` (13.33 × 7.5 inches). All layout files position content
 * within `CONTENT_BOX` to keep header / footer reservations consistent.
 *
 * One source of truth: palette comes from the shared
 * `server/lib/exports/brandPalette.ts` (also consumed by the chartSsr and
 * pptx masters). '#'-prefixed for @react-pdf's CSS subset.
 */
import React from "react";
import { StyleSheet, Text, View } from "@react-pdf/renderer";
import { EXPORT_HEX, EXPORT_CATEGORICAL_HEX, withHash } from "../brandPalette.js";

export const PDF_BRAND = {
  primary: withHash(EXPORT_HEX.primary),
  accent: withHash(EXPORT_HEX.accent),
  foreground: withHash(EXPORT_HEX.foreground),
  muted: withHash(EXPORT_HEX.muted),
  border: withHash(EXPORT_HEX.border),
  background: withHash(EXPORT_HEX.background),
  surfaceMuted: withHash(EXPORT_HEX.surfaceMuted),
  categorical: EXPORT_CATEGORICAL_HEX,
  horizonNow: withHash(EXPORT_HEX.horizonNow),
  horizonThisQuarter: withHash(EXPORT_HEX.horizonThisQuarter),
  horizonStrategic: withHash(EXPORT_HEX.horizonStrategic),
} as const;

/** @react-pdf falls back to its built-in Helvetica when "Inter" isn't registered.
 *  Acceptable for now — registering Inter requires bundling the font file,
 *  which is a follow-up cleanup. The footer / header still hit the brand
 *  palette so the deck still LOOKS branded. */
export const PDF_FONT = "Helvetica";
export const PDF_FONT_BOLD = "Helvetica-Bold";

/** Letter landscape — 11 × 8.5 in = 792 × 612 pt. */
export const PDF_PAGE = {
  widthPt: 792,
  heightPt: 612,
  marginPt: 32,
} as const;

/** Content area within page margins, after header (28pt) + footer (28pt). */
export const PDF_CONTENT = {
  x: PDF_PAGE.marginPt,
  y: PDF_PAGE.marginPt + 28,
  w: PDF_PAGE.widthPt - 2 * PDF_PAGE.marginPt,
  h: PDF_PAGE.heightPt - 2 * PDF_PAGE.marginPt - 56,
} as const;

export const pdfStyles = StyleSheet.create({
  page: {
    backgroundColor: PDF_BRAND.background,
    paddingTop: PDF_PAGE.marginPt + 28,
    paddingBottom: PDF_PAGE.marginPt + 28,
    paddingLeft: PDF_PAGE.marginPt,
    paddingRight: PDF_PAGE.marginPt,
    fontFamily: PDF_FONT,
    fontSize: 10,
    color: PDF_BRAND.foreground,
  },
  header: {
    position: "absolute",
    top: PDF_PAGE.marginPt - 4,
    left: PDF_PAGE.marginPt,
    right: PDF_PAGE.marginPt,
    flexDirection: "column",
  },
  headerRule: {
    height: 1.5,
    backgroundColor: PDF_BRAND.primary,
    marginBottom: 4,
  },
  headerText: {
    fontSize: 8,
    color: PDF_BRAND.muted,
  },
  footer: {
    position: "absolute",
    bottom: PDF_PAGE.marginPt - 4,
    left: PDF_PAGE.marginPt,
    right: PDF_PAGE.marginPt,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: PDF_BRAND.muted,
  },
  footerRule: {
    position: "absolute",
    top: -6,
    left: 0,
    right: 0,
    height: 0.5,
    backgroundColor: PDF_BRAND.border,
  },
  actionTitle: {
    fontSize: 18,
    fontFamily: PDF_FONT_BOLD,
    color: PDF_BRAND.foreground,
    marginBottom: 12,
  },
  bodyText: {
    fontSize: 11,
    color: PDF_BRAND.foreground,
    lineHeight: 1.4,
  },
  mutedText: {
    fontSize: 9,
    color: PDF_BRAND.muted,
  },
});

/**
 * Running page header. Brand line on the left + page title-band rule.
 * Renders inside each `<Page>`'s outer `<View>` so it sits above the
 * content area.
 */
export function PageHeader({
  brandLine,
  pageTitle,
}: {
  brandLine: string;
  pageTitle: string;
}): React.ReactElement {
  return (
    <View style={pdfStyles.header} fixed>
      <View style={pdfStyles.headerRule} />
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={pdfStyles.headerText}>{brandLine}</Text>
        <Text style={pdfStyles.headerText}>{pageTitle}</Text>
      </View>
    </View>
  );
}

/**
 * Running page footer. Date · page x of N · confidentiality.
 * Page numbers come from @react-pdf's `<Text render={({pageNumber, totalPages}) => …}/>`
 * pattern — built-in token resolution at render time.
 */
export function PageFooter({
  generatedAt,
  confidentiality,
}: {
  generatedAt: string;
  confidentiality: string;
}): React.ReactElement {
  return (
    <View style={pdfStyles.footer} fixed>
      <View style={pdfStyles.footerRule} />
      <Text>{`${generatedAt} · ${confidentiality}`}</Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Page ${pageNumber} of ${totalPages}`
        }
      />
    </View>
  );
}

/** Common per-slide context handed to layout components. */
export interface PdfSlideContext {
  brandLine: string;
  generatedAt: string;
  confidentiality: string;
}
