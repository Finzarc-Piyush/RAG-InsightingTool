/**
 * Coalesces redundant intermediate pivot SSE segments in a single agent turn:
 * skip a second flush when it is a thin preview (≤1 row) after a richer prior
 * intermediate already captured multi-row context, or when the preview is
 * materially identical to the prior (signature match).
 */

import { createHash } from "node:crypto";
import type { Message } from "../../shared/schema.js";

export type IntermediatePivotPreviewPayload = {
  preview: Record<string, unknown>[];
  /** Digest of preview rows; compared to skip duplicate flushes */
  previewSignature?: string;
};

export function isIntermediatePivotCoalesceEnabled(): boolean {
  const raw = process.env.AGENT_INTERMEDIATE_PIVOT_COALESCE;
  if (raw === undefined || raw === "") return true;
  return String(raw).trim().toLowerCase() !== "false";
}

function valueSig(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, Object.keys(v as object).sort());
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Stable digest of preview rows for duplicate intermediate detection.
 */
export function intermediatePreviewSignature(
  preview: Record<string, unknown>[]
): string {
  const n = preview.length;
  const lines = preview.slice(0, 12).map((row) => {
    const keys = Object.keys(row).sort();
    return keys.map((k) => `${k}=${valueSig(row[k])}`).join("|");
  });
  const stable = `${n}\n${lines.join("\n")}`;
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * When falling back to parser hints, only keep row/column defaults that exist
 * as keys on preview rows so the pivot UI matches the streamed artifact.
 */
export function filterProvisionalPivotDefaultsToPreviewKeys(
  provisional: Message["pivotDefaults"] | undefined,
  preview: Record<string, unknown>[]
): Message["pivotDefaults"] | undefined {
  if (!provisional) return undefined;
  const keySet = new Set<string>();
  for (const r of preview.slice(0, 50)) {
    for (const k of Object.keys(r)) keySet.add(k);
  }

  const rows = (provisional.rows ?? []).filter((k) => keySet.has(k));
  const columns = (provisional.columns ?? []).filter((k) => keySet.has(k));

  const out: Message["pivotDefaults"] = {};
  if (rows.length) out.rows = rows;
  if (columns.length) out.columns = columns;
  if (provisional.values?.length) {
    out.values = [...provisional.values];
  }

  if (provisional.filterFields?.length && rows.length) {
    const ff = provisional.filterFields.filter((k) => keySet.has(k));
    if (ff.length) out.filterFields = ff;
    if (provisional.filterSelections && ff.length) {
      const fs: Record<string, string[]> = {};
      for (const k of ff) {
        const sel = provisional.filterSelections[k];
        if (sel?.length) fs[k] = sel;
      }
      if (Object.keys(fs).length) out.filterSelections = fs;
    }
  }

  if (!out.rows?.length && !out.values?.length) return undefined;
  return out;
}

/**
 * @returns whether this flush should be emitted (SSE + pending queue).
 */
export function shouldEmitIntermediatePivotFlush(params: {
  priorPendingTail: IntermediatePivotPreviewPayload | undefined;
  incoming: IntermediatePivotPreviewPayload;
}): boolean {
  if (!isIntermediatePivotCoalesceEnabled()) return true;

  const incomingSig = intermediatePreviewSignature(params.incoming.preview);

  const prior = params.priorPendingTail;
  if (prior?.preview?.length) {
    const priorSig =
      prior.previewSignature ?? intermediatePreviewSignature(prior.preview);
    if (incomingSig === priorSig) {
      return false;
    }
  }

  if (!prior?.preview?.length) return true;

  const incomingRows = params.incoming.preview.length;
  const priorRows = prior.preview.length;

  if (incomingRows <= 1 && priorRows >= 2) {
    return false;
  }
  return true;
}
