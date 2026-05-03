/**
 * W59 · Lifecycle entry builders + a fire-and-forget scheduler.
 *
 * Each producer hook (upload, dashboards, computed columns, data ops, user
 * notes) calls one of these builders + `scheduleLifecycleMemory` to record
 * the event into the durable Memory container (W56) and the per-session AI
 * Search index (W57). All writes are best-effort — a Cosmos or Search
 * outage must never surface as a failed user-facing action.
 */
import type { AnalysisMemoryEntry } from "../../../shared/schema.js";
import type { ComputedColumnDef } from "../../computedColumns.js";
import { buildMemoryEntryId, appendMemoryEntries } from "../../../models/analysisMemory.model.js";
import { scheduleIndexMemoryEntries } from "../../rag/indexSession.js";

const TITLE_MAX = 200;
const SUMMARY_MAX = 1500;

function clip(s: string | undefined, max: number): string {
  const trimmed = (s ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function buildAnalysisCreatedEntry(args: {
  sessionId: string;
  username: string;
  fileName: string;
  fileSize: number;
  createdAt: number;
}): AnalysisMemoryEntry {
  const sizeMb = (args.fileSize / (1024 * 1024)).toFixed(2);
  return {
    id: buildMemoryEntryId(args.sessionId, "analysis_created", 0),
    sessionId: args.sessionId,
    username: args.username,
    createdAt: args.createdAt,
    sequence: 0,
    type: "analysis_created",
    actor: "system",
    title: clip(`Analysis started: ${args.fileName}`, TITLE_MAX),
    summary: clip(
      `Dataset uploaded — ${args.fileName} (${sizeMb} MB). Enrichment pending.`,
      SUMMARY_MAX
    ),
    body: { fileName: args.fileName, fileSize: args.fileSize },
  };
}

export function buildEnrichmentCompleteEntry(args: {
  sessionId: string;
  username: string;
  rowCount: number;
  columnCount: number;
  suggestedQuestions: string[];
  createdAt: number;
}): AnalysisMemoryEntry {
  const sq = args.suggestedQuestions.slice(0, 4).join(" • ");
  return {
    id: buildMemoryEntryId(args.sessionId, "enrichment_complete", 0),
    sessionId: args.sessionId,
    username: args.username,
    createdAt: args.createdAt,
    sequence: 0,
    type: "enrichment_complete",
    actor: "system",
    title: clip(
      `Dataset profiled: ${args.rowCount.toLocaleString()} rows × ${args.columnCount} cols`,
      TITLE_MAX
    ),
    summary: clip(
      `Profile + suggested-question seed complete. Starter prompts: ${sq || "(none generated)"}`,
      SUMMARY_MAX
    ),
    body: {
      rowCount: args.rowCount,
      columnCount: args.columnCount,
      suggestedQuestions: args.suggestedQuestions.slice(0, 12),
    },
  };
}

export function buildDashboardPromotedEntry(args: {
  sessionId: string;
  username: string;
  dashboardId: string;
  dashboardName: string;
  sheetCount: number;
  chartCount: number;
  createdAt: number;
  turnId?: string;
}): AnalysisMemoryEntry {
  return {
    id: buildMemoryEntryId(
      args.sessionId,
      "dashboard_promoted",
      0,
      args.turnId
    ),
    sessionId: args.sessionId,
    username: args.username,
    createdAt: args.createdAt,
    turnId: args.turnId,
    sequence: 0,
    type: "dashboard_promoted",
    actor: "user",
    title: clip(`Dashboard saved: ${args.dashboardName}`, TITLE_MAX),
    summary: clip(
      `User promoted draft to a saved dashboard "${args.dashboardName}" with ${args.sheetCount} sheet(s) and ${args.chartCount} chart(s).`,
      SUMMARY_MAX
    ),
    body: {
      dashboardName: args.dashboardName,
      sheetCount: args.sheetCount,
      chartCount: args.chartCount,
    },
    refs: { dashboardId: args.dashboardId },
  };
}

export function buildDashboardPatchedEntry(args: {
  sessionId: string;
  username: string;
  dashboardId: string;
  dashboardName: string;
  addedCount: number;
  removedCount: number;
  renamedSheetTo?: string;
  createdAt: number;
  turnId?: string;
}): AnalysisMemoryEntry {
  const ops: string[] = [];
  if (args.addedCount > 0) ops.push(`added ${args.addedCount} chart(s)`);
  if (args.removedCount > 0) ops.push(`removed ${args.removedCount} chart(s)`);
  if (args.renamedSheetTo) ops.push(`renamed sheet to "${args.renamedSheetTo}"`);
  const opSummary = ops.join("; ") || "no-op";
  return {
    id: buildMemoryEntryId(
      args.sessionId,
      "dashboard_patched",
      Math.floor(args.createdAt / 1000),
      args.turnId
    ),
    sessionId: args.sessionId,
    username: args.username,
    createdAt: args.createdAt,
    turnId: args.turnId,
    sequence: Math.floor(args.createdAt / 1000),
    type: "dashboard_patched",
    actor: "user",
    title: clip(`Dashboard edited: ${args.dashboardName}`, TITLE_MAX),
    summary: clip(
      `Edited dashboard "${args.dashboardName}" — ${opSummary}.`,
      SUMMARY_MAX
    ),
    body: {
      dashboardName: args.dashboardName,
      addedCount: args.addedCount,
      removedCount: args.removedCount,
      renamedSheetTo: args.renamedSheetTo,
    },
    refs: { dashboardId: args.dashboardId },
  };
}

export function buildComputedColumnEntry(args: {
  sessionId: string;
  username: string;
  columns: Array<{ name: string; def: ComputedColumnDef }>;
  persistedToBlob: boolean;
  description?: string;
  dataVersion?: number;
  createdAt: number;
  turnId?: string;
  sequence?: number;
}): AnalysisMemoryEntry {
  const seq = args.sequence ?? 0;
  const names = args.columns.map((c) => c.name).join(", ");
  const defSummary = args.columns
    .map((c) => `${c.name} = ${describeComputedDef(c.def)}`)
    .join("; ");
  const persistNote = args.persistedToBlob
    ? " Persisted as a new blob version."
    : " Held in-memory for this turn only.";
  return {
    id: buildMemoryEntryId(
      args.sessionId,
      "computed_column_added",
      seq,
      args.turnId
    ),
    sessionId: args.sessionId,
    username: args.username,
    createdAt: args.createdAt,
    turnId: args.turnId,
    sequence: seq,
    type: "computed_column_added",
    actor: "agent",
    title: clip(`Computed columns added: ${names}`, TITLE_MAX),
    summary: clip(`${defSummary}.${persistNote}`, SUMMARY_MAX),
    body: {
      columns: args.columns,
      persistedToBlob: args.persistedToBlob,
      description: args.description,
    },
    dataVersion: args.dataVersion,
  };
}

function describeComputedDef(def: ComputedColumnDef): string {
  if (def.type === "date_diff_days") {
    const clamp = def.clampNegative ? " (clamp negative)" : "";
    return `date_diff_days(${def.startColumn}, ${def.endColumn})${clamp}`;
  }
  return `${def.leftColumn} ${def.op} ${def.rightColumn}`;
}

export function buildDataOpEntry(args: {
  sessionId: string;
  username: string;
  operation: string;
  description: string;
  dataVersion: number;
  rowsBefore: number;
  rowsAfter: number;
  blobName?: string;
  createdAt: number;
  turnId?: string;
  sequence?: number;
}): AnalysisMemoryEntry {
  const seq = args.sequence ?? 0;
  const delta = args.rowsAfter - args.rowsBefore;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return {
    id: buildMemoryEntryId(args.sessionId, "data_op", seq, args.turnId),
    sessionId: args.sessionId,
    username: args.username,
    createdAt: args.createdAt,
    turnId: args.turnId,
    sequence: seq,
    type: "data_op",
    actor: "agent",
    title: clip(`${args.operation} → v${args.dataVersion}`, TITLE_MAX),
    summary: clip(
      `${args.description} • rows ${args.rowsBefore.toLocaleString()} → ${args.rowsAfter.toLocaleString()} (${sign})`,
      SUMMARY_MAX
    ),
    body: {
      operation: args.operation,
      description: args.description,
      rowsBefore: args.rowsBefore,
      rowsAfter: args.rowsAfter,
    },
    dataVersion: args.dataVersion,
    refs: { dataVersion: args.dataVersion, blobName: args.blobName },
  };
}

export function buildUserNoteEntry(args: {
  sessionId: string;
  username: string;
  noteText: string;
  createdAt: number;
}): AnalysisMemoryEntry | null {
  const text = args.noteText.trim();
  if (!text) return null;
  // Truncate the note for the summary; the full text already lives on the
  // chat doc's permanentContext field, so the journal entry is just an audit
  // marker (when, who, gist) — not the source of truth.
  const preview = clip(text, 800);
  return {
    id: buildMemoryEntryId(
      args.sessionId,
      "user_note",
      Math.floor(args.createdAt / 1000)
    ),
    sessionId: args.sessionId,
    username: args.username,
    createdAt: args.createdAt,
    sequence: Math.floor(args.createdAt / 1000),
    type: "user_note",
    actor: "user",
    title: clip(`User added context note`, TITLE_MAX),
    summary: clip(`Note: "${preview}"`, SUMMARY_MAX),
    body: { noteText: text.slice(0, 4000) },
  };
}

/**
 * Best-effort scheduler — appends to Cosmos and indexes to AI Search.
 * Fire-and-forget; the caller never awaits Search and only awaits the Cosmos
 * write when it really needs the entry to be readable on the next request.
 * For routine lifecycle hooks, use `scheduleLifecycleMemory` (returns void).
 */
export async function persistLifecycleMemory(
  entry: AnalysisMemoryEntry
): Promise<void> {
  await appendMemoryEntries([entry]);
  scheduleIndexMemoryEntries([entry]);
}

export function scheduleLifecycleMemory(entry: AnalysisMemoryEntry): void {
  setImmediate(() => {
    persistLifecycleMemory(entry).catch((e) =>
      console.warn("⚠️ analysisMemory lifecycle write failed:", e)
    );
  });
}
