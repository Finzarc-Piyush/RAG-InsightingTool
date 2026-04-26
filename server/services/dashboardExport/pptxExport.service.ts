/**
 * W7.3 · PPT export of a saved Dashboard.
 *
 * v1 layout (no chart screenshots — Puppeteer/Chromium adds 200MB+ of deps and
 * a 5s cold-render per chart; revisit when there's demand):
 *   - Title slide: dashboard name + meta footer
 *   - One slide per sheet:
 *       - Sheet name as title
 *       - Narrative blocks rendered as bullets / paragraphs (role-aware)
 *       - Charts listed by type + title with a "open in app" reminder
 *
 * The PPT is small (~50KB for typical dashboards), opens in PowerPoint /
 * Keynote / Google Slides, and is good enough to drop into a board pack.
 */

import type { Dashboard, ChartSpec, DashboardNarrativeBlock } from "../../shared/schema.js";

/**
 * pptxgenjs exports its constructor as a CommonJS default. Under our ESM build
 * `import X from "pptxgenjs"` sometimes resolves to the namespace object whose
 * `.default` is the actual constructor. Dynamic-import + manual fallback covers
 * both shapes without breaking either bundler.
 */
async function loadPptxGenJSCtor(): Promise<new () => unknown> {
  const mod: unknown = await import("pptxgenjs");
  const direct = mod as { default?: unknown };
  const ctor = (typeof direct === "function" ? direct : direct?.default) as
    | (new () => unknown)
    | undefined;
  if (typeof ctor !== "function") {
    throw new Error("pptxgenjs default export is not a constructor");
  }
  return ctor;
}

const COLOR_TITLE = "1F2937"; // slate-800
const COLOR_MUTED = "6B7280"; // gray-500
const COLOR_PRIMARY = "2563EB"; // blue-600

function safeText(raw: unknown, max = 800): string {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function bulletForBlock(block: DashboardNarrativeBlock): string {
  const role = block.role || "custom";
  const title = block.title?.trim();
  const body = safeText(block.body, 600);
  const prefix = role === "summary" ? "" : `${role.toUpperCase()}: `;
  if (title) return `${prefix}${title} — ${body}`;
  return `${prefix}${body}`;
}

export async function buildDashboardPptxBuffer(dashboard: Dashboard): Promise<Buffer> {
  const PptxGenJS = await loadPptxGenJSCtor();
  // Cast to a pragmatic structural type — pptxgenjs's typings are extensive
  // and not worth re-importing under the dynamic-import shim.
  const pres = new PptxGenJS() as {
    author: string;
    title: string;
    layout: string;
    addSlide(): {
      background: { color: string };
      addText(text: unknown, options: Record<string, unknown>): void;
    };
    write(opts: { outputType: string }): Promise<unknown>;
  };
  pres.author = "Marico Insighting Tool";
  pres.title = dashboard.name;
  pres.layout = "LAYOUT_WIDE"; // 13.33×7.5

  // ── Title slide
  const cover = pres.addSlide();
  cover.background = { color: "FFFFFF" };
  cover.addText(dashboard.name, {
    x: 0.6,
    y: 2.6,
    w: 12,
    h: 1.5,
    fontSize: 40,
    bold: true,
    color: COLOR_TITLE,
    fontFace: "Inter",
  });
  const subtitleParts = [
    `${dashboard.sheets?.length ?? 0} sheet${(dashboard.sheets?.length ?? 0) === 1 ? "" : "s"}`,
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ];
  cover.addText(subtitleParts.join(" · "), {
    x: 0.6,
    y: 4.1,
    w: 12,
    h: 0.6,
    fontSize: 14,
    color: COLOR_MUTED,
    fontFace: "Inter",
  });

  // ── One slide per sheet
  for (const sheet of dashboard.sheets ?? []) {
    const slide = pres.addSlide();
    slide.background = { color: "FFFFFF" };

    slide.addText(sheet.name || sheet.id || "Sheet", {
      x: 0.5,
      y: 0.4,
      w: 12.3,
      h: 0.7,
      fontSize: 24,
      bold: true,
      color: COLOR_TITLE,
      fontFace: "Inter",
    });

    let cursorY = 1.3;

    // Narrative blocks
    const blocks = sheet.narrativeBlocks ?? [];
    if (blocks.length > 0) {
      const text = blocks.map((b) => bulletForBlock(b)).map((line) => ({
        text: line,
        options: { bullet: true, paraSpaceAfter: 4, fontSize: 13, color: COLOR_TITLE },
      }));
      const blockHeight = Math.min(3.0, 0.5 + blocks.length * 0.5);
      slide.addText(text, {
        x: 0.5,
        y: cursorY,
        w: 12.3,
        h: blockHeight,
        fontFace: "Inter",
        valign: "top",
      });
      cursorY += blockHeight + 0.15;
    }

    // Charts — list metadata only (no screenshots in v1)
    const charts: ChartSpec[] = sheet.charts ?? [];
    if (charts.length > 0) {
      slide.addText("Charts", {
        x: 0.5,
        y: cursorY,
        w: 12.3,
        h: 0.4,
        fontSize: 14,
        bold: true,
        color: COLOR_PRIMARY,
        fontFace: "Inter",
      });
      cursorY += 0.5;
      const chartLines = charts.map((c) => {
        const provenance = (c as { _agentProvenance?: { toolCalls?: Array<{ tool: string; rowsOut?: number }> } })
          ._agentProvenance?.toolCalls?.[0];
        const provText = provenance
          ? ` · via ${provenance.tool}${typeof provenance.rowsOut === "number" ? ` (${provenance.rowsOut} rows)` : ""}`
          : "";
        return {
          text: `${c.type ?? "chart"} · ${c.title ?? "(untitled)"}${provText}`,
          options: { bullet: true, paraSpaceAfter: 3, fontSize: 12, color: COLOR_TITLE },
        };
      });
      const chartsHeight = Math.min(7.5 - cursorY - 0.6, 0.4 + charts.length * 0.4);
      slide.addText(chartLines, {
        x: 0.7,
        y: cursorY,
        w: 12.0,
        h: chartsHeight,
        fontFace: "Inter",
        valign: "top",
      });
    }

    // Footer hint
    slide.addText(
      "Open the dashboard in the Marico Insighting Tool to interact with charts and drill in.",
      {
        x: 0.5,
        y: 7.0,
        w: 12.3,
        h: 0.4,
        fontSize: 10,
        italic: true,
        color: COLOR_MUTED,
        fontFace: "Inter",
      }
    );
  }

  // pptxgenjs returns a base64 string when called with `outputType: "base64"`.
  // Use "nodebuffer" for direct Buffer output.
  const buf = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return buf;
}
