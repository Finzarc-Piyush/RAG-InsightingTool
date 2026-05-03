/**
 * ExportMenu — PNG / SVG / CSV export. WC8.1.
 *
 * PNG: html-to-image (already in deps) snapshots the chart container.
 * SVG: serialize the first <svg> child of the container.
 * CSV: serialize the rows passed in via `data`.
 *
 * Wires onto a chart container ref. Wrap any <PremiumChart> with a
 * `<div ref={ref}>...</div>` and pass that ref here.
 */

import {
  type RefObject,
  useCallback,
  useState,
} from "react";
import { Download, FileImage, FileText, FileType } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Row } from "@/lib/charts/encodingResolver";

export interface ExportMenuProps {
  containerRef: RefObject<HTMLElement>;
  /** Underlying rows for CSV export. */
  data?: Row[];
  /** Filename prefix (no extension). */
  filename?: string;
  className?: string;
  compact?: boolean;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function rowsToCsv(rows: Row[]): string {
  if (rows.length === 0) return "";
  const headers = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      for (const k of Object.keys(r)) acc.add(k);
      return acc;
    }, new Set()),
  );
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines: string[] = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(r[h])).join(","));
  }
  return lines.join("\n");
}

export function ExportMenu({
  containerRef,
  data,
  filename = "chart",
  className,
  compact = false,
}: ExportMenuProps) {
  const [busy, setBusy] = useState<"png" | "svg" | "csv" | null>(null);

  const onPng = useCallback(async () => {
    if (!containerRef.current) return;
    setBusy("png");
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(containerRef.current, {
        cacheBust: true,
        pixelRatio: 2,
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${filename}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setBusy(null);
    }
  }, [containerRef, filename]);

  const onSvg = useCallback(() => {
    if (!containerRef.current) return;
    setBusy("svg");
    try {
      const svg = containerRef.current.querySelector("svg");
      if (!svg) return;
      const xml = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
      downloadBlob(blob, `${filename}.svg`);
    } finally {
      setBusy(null);
    }
  }, [containerRef, filename]);

  const onCsv = useCallback(() => {
    if (!data) return;
    setBusy("csv");
    try {
      const csv = rowsToCsv(data);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      downloadBlob(blob, `${filename}.csv`);
    } finally {
      setBusy(null);
    }
  }, [data, filename]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={
          (compact ? "h-7 px-2 text-xs " : "h-8 px-3 text-xs ") +
          "inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-card text-foreground transition-colors hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-primary/40 " +
          (className ?? "")
        }
        aria-label="Export chart"
      >
        <Download className="h-3.5 w-3.5" />
        Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onClick={onPng}
          disabled={busy === "png"}
          className="gap-2"
        >
          <FileImage className="h-3.5 w-3.5" />
          {busy === "png" ? "Saving…" : "PNG image"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onSvg}
          disabled={busy === "svg"}
          className="gap-2"
        >
          <FileType className="h-3.5 w-3.5" />
          SVG vector
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onCsv}
          disabled={busy === "csv" || !data}
          className="gap-2"
        >
          <FileText className="h-3.5 w-3.5" />
          CSV data
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
