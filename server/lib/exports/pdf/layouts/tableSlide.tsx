/**
 * W-EXP-8 · TableSlide PDF page.
 *
 * Native table rendering via flexbox grid — no images. Tables-as-image
 * are forbidden per the deck verifier's hard rules.
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

export interface PdfTableData {
  caption?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface PdfTableDeps {
  resolveTable: (tableId: string) => PdfTableData | null;
}

interface Props {
  spec: Extract<SlideSpec, { layout: "TableSlide" }>;
  ctx: PdfSlideContext;
  deps: PdfTableDeps;
}

export function TableSlidePage({ spec, ctx, deps }: Props): React.ReactElement {
  const ref = spec.slots.tableRef;
  const table: PdfTableData | null =
    ref.kind === "ref"
      ? deps.resolveTable(ref.tableId)
      : { caption: spec.slots.caption, columns: ref.columns, rows: ref.rows };

  return (
    <Page size="LETTER" orientation="landscape" style={pdfStyles.page}>
      <PageHeader brandLine={ctx.brandLine} pageTitle="Data" />
      <Text style={pdfStyles.actionTitle}>{spec.actionTitle}</Text>
      {spec.slots.insight && (
        <Text style={{ fontSize: 11, fontStyle: "italic", color: PDF_BRAND.muted, marginBottom: 10 }}>
          {spec.slots.insight}
        </Text>
      )}
      {table ? (
        <View style={{ flex: 1, borderTopWidth: 0.5, borderTopColor: PDF_BRAND.border }}>
          <View
            style={{
              flexDirection: "row",
              backgroundColor: PDF_BRAND.primary,
              padding: 6,
            }}
          >
            {table.columns.map((col, i) => (
              <Text
                key={i}
                style={{
                  flex: 1,
                  color: PDF_BRAND.background,
                  fontFamily: PDF_FONT_BOLD,
                  fontSize: 9,
                }}
              >
                {col}
              </Text>
            ))}
          </View>
          {table.rows.slice(0, 60).map((row, ri) => (
            <View
              key={ri}
              style={{
                flexDirection: "row",
                backgroundColor: ri % 2 === 0 ? PDF_BRAND.background : PDF_BRAND.surfaceMuted,
                padding: 5,
                borderBottomWidth: 0.25,
                borderBottomColor: PDF_BRAND.border,
              }}
            >
              {row.map((cell, ci) => (
                <Text
                  key={ci}
                  style={{
                    flex: 1,
                    fontSize: 9,
                    color: PDF_BRAND.foreground,
                    textAlign: typeof cell === "number" ? "right" : "left",
                    paddingRight: 8,
                  }}
                >
                  {cell == null ? "" : String(cell)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : (
        <View
          style={{
            flex: 1,
            backgroundColor: PDF_BRAND.surfaceMuted,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: 4,
            borderWidth: 0.5,
            borderColor: PDF_BRAND.border,
          }}
        >
          <Text style={{ color: PDF_BRAND.muted, fontSize: 12 }}>Table unavailable for this slide.</Text>
        </View>
      )}
      <PageFooter generatedAt={ctx.generatedAt} confidentiality={ctx.confidentiality} />
    </Page>
  );
}
