import type { DataSummary } from "../../shared/schema.js";
import type { ChatDocument } from "../../models/chat.model.js";

export interface RagChunk {
  chunkId: string;
  chunkType: "summary" | "sample" | "rows" | "duckdb_sample" | "user_context";
  content: string;
  rowStart?: number;
  rowEnd?: number;
}

export const USER_CONTEXT_CHUNK_ID = "user_context";

const ROWS_PER_CHUNK = 50;
const MAX_ROW_CHUNKS = 40;
const MAX_IN_MEMORY_ROWS = 50_000;

function summaryChunk(summary: DataSummary): RagChunk {
  const colLines = summary.columns
    .map((c) => `- ${c.name} (${c.type})`)
    .join("\n");
  const content = `Dataset summary
Rows: ${summary.rowCount}
Columns (${summary.columnCount}):
${colLines}
Numeric columns: ${summary.numericColumns.join(", ") || "(none)"}
Date columns: ${summary.dateColumns.join(", ") || "(none)"}`;
  return { chunkId: "summary", chunkType: "summary", content };
}

function sampleChunk(sampleRows: Record<string, any>[]): RagChunk {
  const text = JSON.stringify(sampleRows.slice(0, 30), null, 0).slice(0, 12_000);
  return {
    chunkId: "sample",
    chunkType: "sample",
    content: `Sample rows (up to 30):\n${text}`,
  };
}

function rowWindowChunks(data: Record<string, any>[]): RagChunk[] {
  const chunks: RagChunk[] = [];
  const n = Math.min(data.length, MAX_IN_MEMORY_ROWS);
  let idx = 0;
  let chunkIndex = 0;
  while (idx < n && chunkIndex < MAX_ROW_CHUNKS) {
    const end = Math.min(idx + ROWS_PER_CHUNK, n);
    const slice = data.slice(idx, end);
    const text = JSON.stringify(slice, null, 0).slice(0, 14_000);
    chunks.push({
      chunkId: `rows-${chunkIndex}`,
      chunkType: "rows",
      content: `Rows ${idx}-${end - 1}:\n${text}`,
      rowStart: idx,
      rowEnd: end - 1,
    });
    idx = end;
    chunkIndex++;
  }
  return chunks;
}

function duckdbSampleChunk(sample: Record<string, any>[]): RagChunk {
  const text = JSON.stringify(sample.slice(0, 40), null, 0).slice(0, 12_000);
  return {
    chunkId: "duckdb_sample",
    chunkType: "duckdb_sample",
    content: `Columnar store sample (up to 40 rows):\n${text}`,
  };
}

export function userContextChunk(permanentContext: string): RagChunk {
  return {
    chunkId: USER_CONTEXT_CHUNK_ID,
    chunkType: "user_context",
    content: `User-provided analysis context:\n${permanentContext.trim()}`,
  };
}

/**
 * Build tiered chunks for indexing. Caller supplies optional full data or DuckDB sample rows.
 */
export function buildChunksForSession(params: {
  doc: ChatDocument;
  /** In-memory rows when available (bounded). */
  dataRows?: Record<string, any>[];
  /** From getSampleFromDuckDB when columnar. */
  duckdbSampleRows?: Record<string, any>[];
}): RagChunk[] {
  const { doc, dataRows, duckdbSampleRows } = params;
  const chunks: RagChunk[] = [];

  // Prepend user-provided context so it ranks reliably in retrieval.
  if (doc.permanentContext?.trim()) {
    chunks.push(userContextChunk(doc.permanentContext));
  }

  chunks.push(summaryChunk(doc.dataSummary));

  if (doc.sampleRows?.length) {
    chunks.push(sampleChunk(doc.sampleRows));
  }

  if (dataRows && dataRows.length > 0 && dataRows.length <= MAX_IN_MEMORY_ROWS) {
    chunks.push(...rowWindowChunks(dataRows));
  } else if (duckdbSampleRows && duckdbSampleRows.length > 0) {
    chunks.push(duckdbSampleChunk(duckdbSampleRows));
  }

  return chunks;
}
