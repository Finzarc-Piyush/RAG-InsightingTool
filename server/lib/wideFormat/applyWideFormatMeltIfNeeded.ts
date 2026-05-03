// WPF4 · Defensive re-melt for fallback data-load paths.
//
// When a chat session was uploaded as a wide-format spreadsheet, the upload
// pipeline auto-melted the data and stamped `dataSummary.wideFormatTransform`.
// The post-melt long-form rows are stored in `currentDataBlob` (JSON) AND
// (for small files) directly in `chatDocument.rawData`. The original wide
// buffer survives in blob storage for download.
//
// Failure path: when both `currentDataBlob` and `rawData` are missing (true
// for any wide file > 10 000 rows after melt — its rawData was stripped to
// fit the Cosmos document size budget), `dataLoader.loadLatestData` falls
// back to re-parsing the original wide buffer via `parseFile`. The result is
// WIDE rows again, but every downstream consumer expects LONG rows.
// Without re-melt, every analytical tool that reads from `loadLatestData`
// (correlation, segment-driver, in-memory analytical fallback) silently runs
// on the wrong shape.
//
// This helper is the single re-melt seam: callers feed in the parsed rows
// and the session's `dataSummary`; if `wideFormatTransform.detected` is true
// AND the rows look like the original wide shape (no Period/Value yet), we
// re-classify and re-melt. If the rows already look long-form (defensive:
// `Period` and `valueColumn` present), we return them unchanged.

import type { DataSummary } from "../../shared/schema.js";
import { classifyDataset } from "./classifyDataset.js";
import { meltDataset } from "./meltDataset.js";

export interface ApplyWideFormatMeltResult {
  rows: Record<string, unknown>[];
  /** True when meltDataset was actually re-applied. */
  remelted: boolean;
  /** Reason for the (no-)remelt — used for logging. */
  reason:
    | "no_wide_format_transform"
    | "rows_empty"
    | "already_long_form"
    | "classify_disagrees"
    | "remelted";
}

export function applyWideFormatMeltIfNeeded(
  rows: Record<string, unknown>[],
  dataSummary: DataSummary | undefined | null
): ApplyWideFormatMeltResult {
  const wf = dataSummary?.wideFormatTransform;
  if (!wf?.detected) return { rows, remelted: false, reason: "no_wide_format_transform" };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rows, remelted: false, reason: "rows_empty" };
  }

  const headers = Object.keys(rows[0] ?? {});
  // Fast-path: already long-form. Defensive — when the helper is called
  // against the JSON `currentDataBlob` that already contains long rows, we
  // must NOT melt twice.
  const looksLong =
    headers.includes(wf.periodColumn) &&
    headers.includes(wf.valueColumn) &&
    headers.includes(wf.periodIsoColumn);
  if (looksLong) {
    return { rows, remelted: false, reason: "already_long_form" };
  }

  const classification = classifyDataset(headers);
  if (!classification.isWide) {
    // Headers don't classify as wide — could be a partial column list (large
    // file column-filtered load) or schema drift. Don't melt; degrade gracefully.
    return { rows, remelted: false, reason: "classify_disagrees" };
  }

  const melted = meltDataset(rows, classification);
  return { rows: melted.rows, remelted: true, reason: "remelted" };
}
