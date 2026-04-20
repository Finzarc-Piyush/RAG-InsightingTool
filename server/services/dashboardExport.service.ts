import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import type { Dashboard, DashboardNarrativeBlock, DashboardSheet } from "../shared/schema.js";

function wrapText(text: string, maxChars: number): string[] {
  const words = text.replace(/\r\n/g, "\n").split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!w) continue;
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

const PDF_PAGE_SIZE: [number, number] = [612, 792];
const PDF_BOTTOM_MARGIN = 48;
const PDF_TOP_START = 740;

type PdfCursor = { doc: PDFDocument; page: PDFPage; y: number };

function ensureVerticalSpace(cur: PdfCursor, needLines: number, lineHeight: number): void {
  const minY = PDF_BOTTOM_MARGIN + needLines * lineHeight;
  if (cur.y >= minY) return;
  cur.page = cur.doc.addPage(PDF_PAGE_SIZE);
  cur.y = PDF_TOP_START;
}

function drawParagraphPaged(
  cur: PdfCursor,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  text: string,
  x: number,
  maxWidth: number,
  size: number,
  lineHeight: number
): void {
  const maxChars = Math.max(20, Math.floor(maxWidth / (size * 0.45)));
  for (const para of text.split(/\n\n+/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    for (const line of wrapText(trimmed, maxChars)) {
      ensureVerticalSpace(cur, 1, lineHeight);
      cur.page.drawText(line, { x, y: cur.y, size, font, color: rgb(0.1, 0.1, 0.1) });
      cur.y -= lineHeight;
    }
    ensureVerticalSpace(cur, 1, lineHeight);
    cur.y -= lineHeight * 0.25;
  }
}

export async function buildDashboardPdf(dashboard: Dashboard): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const sheets: DashboardSheet[] =
    dashboard.sheets?.length ?
      [...dashboard.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [
        {
          id: "default",
          name: "Overview",
          charts: dashboard.charts ?? [],
        },
      ];

  for (const sheet of sheets) {
    const cur: PdfCursor = {
      doc,
      page: doc.addPage(PDF_PAGE_SIZE),
      y: PDF_TOP_START,
    };
    cur.page.drawText(`${dashboard.name} — ${sheet.name}`, {
      x: 48,
      y: cur.y,
      size: 16,
      font: fontBold,
      color: rgb(0, 0, 0.4),
    });
    cur.y -= 28;

    const blocks: DashboardNarrativeBlock[] = [...(sheet.narrativeBlocks ?? [])].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
    );
    for (const b of blocks) {
      ensureVerticalSpace(cur, 2, 14);
      cur.page.drawText(b.title, { x: 48, y: cur.y, size: 12, font: fontBold });
      cur.y -= 16;
      drawParagraphPaged(cur, font, b.body, 48, 520, 10, 12);
      cur.y -= 12;
    }

    if (sheet.charts?.length) {
      ensureVerticalSpace(cur, 2, 14);
      cur.page.drawText(`Charts (${sheet.charts.length})`, {
        x: 48,
        y: cur.y,
        size: 11,
        font: fontBold,
      });
      cur.y -= 14;
      for (const c of sheet.charts) {
        const line = `• ${c.title} (${c.type}: ${c.x} vs ${c.y})`;
        ensureVerticalSpace(cur, 1, 12);
        cur.page.drawText(line.slice(0, 120), { x: 56, y: cur.y, size: 9, font });
        cur.y -= 12;
      }
    }

    if (sheet.tables?.length) {
      for (const t of sheet.tables) {
        ensureVerticalSpace(cur, 4, 12);
        cur.page.drawText(t.caption, { x: 48, y: cur.y, size: 11, font: fontBold });
        cur.y -= 14;
        const header = t.columns.join(" | ").slice(0, 100);
        cur.page.drawText(header, { x: 48, y: cur.y, size: 8, font: fontBold });
        cur.y -= 11;
        for (const row of t.rows.slice(0, 25)) {
          ensureVerticalSpace(cur, 1, 10);
          cur.page.drawText(row.map((c) => String(c ?? "")).join(" | ").slice(0, 110), {
            x: 48,
            y: cur.y,
            size: 7,
            font,
          });
          cur.y -= 10;
        }
      }
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export async function buildDashboardPptx(dashboard: Dashboard): Promise<Buffer> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "RAG-InsightingTool";

  const slideTitle = pptx.addSlide();
  slideTitle.addText(dashboard.name, {
    x: 0.5,
    y: 1.2,
    w: 9,
    h: 1,
    fontSize: 28,
    bold: true,
  });
  slideTitle.addText("Exported analysis report", {
    x: 0.5,
    y: 2.4,
    w: 9,
    fontSize: 14,
    color: "666666",
  });

  const sheets: DashboardSheet[] =
    dashboard.sheets?.length ?
      [...dashboard.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [
        {
          id: "default",
          name: "Overview",
          charts: dashboard.charts ?? [],
        },
      ];

  for (const sheet of sheets) {
    const blocks = [...(sheet.narrativeBlocks ?? [])].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
    );
    for (const b of blocks) {
      const s = pptx.addSlide();
      s.addText(`${sheet.name}: ${b.title}`, {
        x: 0.4,
        y: 0.35,
        w: 9,
        fontSize: 18,
        bold: true,
      });
      s.addText(b.body.slice(0, 8000), {
        x: 0.4,
        y: 1,
        w: 9,
        h: 4.5,
        fontSize: 12,
        valign: "top",
      });
    }

    if (sheet.charts?.length) {
      const s = pptx.addSlide();
      s.addText(`${sheet.name} — charts`, {
        x: 0.4,
        y: 0.35,
        w: 9,
        fontSize: 18,
        bold: true,
      });
      const chartList = sheet.charts
        .map((c) => `• ${c.title} (${c.type}: ${c.x} / ${c.y})`)
        .join("\n");
      s.addText(chartList.slice(0, 8000), { x: 0.5, y: 1, w: 9, h: 4, fontSize: 12, valign: "top" });
    }

    for (const tbl of sheet.tables ?? []) {
      const s = pptx.addSlide();
      s.addText(tbl.caption, { x: 0.4, y: 0.35, w: 9, fontSize: 16, bold: true });
      const header = tbl.columns.join("\t");
      const lines = [
        header,
        ...tbl.rows.slice(0, 24).map((r) => r.map((c) => String(c ?? "")).join("\t")),
      ].join("\n");
      s.addText(lines.slice(0, 9000), {
        x: 0.4,
        y: 1,
        w: 9,
        h: 4.5,
        fontSize: 9,
        valign: "top",
      });
    }
  }

  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return out;
}
