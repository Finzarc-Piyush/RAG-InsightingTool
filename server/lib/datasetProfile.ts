import {
  datasetProfileSchema,
  type DatasetProfile,
} from '../shared/schema.js';
import { completeJson } from './agents/runtime/llmJson.js';

export type { DatasetProfile };
export { datasetProfileSchema };

export const emptyDatasetProfile = (): DatasetProfile => ({
  shortDescription: '',
  dateColumns: [],
  suggestedQuestions: [],
});

/** Smaller sample = faster profile LLM; 60 rows usually enough for header/date inference */
const MAX_SAMPLE_ROWS = 60;
const MAX_CELL_CHARS = 200;

function buildLlmPayload(data: Record<string, any>[]) {
  if (!data.length) {
    return { columns: [] as string[], sampleRows: [] as Record<string, unknown>[] };
  }
  const columns = Object.keys(data[0]);
  const sampleRows = data.slice(0, MAX_SAMPLE_ROWS).map((row) => {
    const o: Record<string, unknown> = {};
    for (const k of columns) {
      let v = row[k];
      if (v instanceof Date) v = v.toISOString();
      else if (typeof v === 'string' && v.length > MAX_CELL_CHARS) {
        v = `${v.slice(0, MAX_CELL_CHARS)}…`;
      }
      o[k] = v;
    }
    return o;
  });
  return { columns, sampleRows };
}

const SYSTEM_PROMPT = `You are a data analyst. You receive JSON with "columns" (header names in order) and "sampleRows" (up to 100 raw rows — values may be messy: mixed date formats, text, numbers).

Return ONLY a JSON object with these keys:
- shortDescription: 1–3 sentences describing what the dataset is about.
- dateColumns: every column that holds dates, datetimes, or business period labels that represent time (exact header names from "columns"). Include messy string encodings (e.g. "Q1 27-Feb '25", "H1 Q1", fiscal labels). If none, use []. Do not include identifier columns (row id, order id, etc.).
- dirtyStringDateColumns: subset of dateColumns where values in the sample are mostly plain strings (or mixed) and are NOT already ISO/standard datetimes or native timestamps in the sample — i.e. the column needs a cleaned parse pass. Columns where every non-null sample value is already an ISO-like datetime string or unambiguous standard format should NOT be listed here. If none need cleaning, use [].
- suggestedQuestions: 5–8 short, concrete analytical questions a user might ask. Do NOT include questions about identifier or key columns (those in idColumns — they are row keys, not dimensions). Do NOT ask "how does [date column] trend over time" — date columns are time axes; instead ask how a numeric metric changes over the date column.
- measureColumns: names of numeric metric columns (revenue, quantity, etc.), subset of "columns".
- idColumns: identifier columns (customer id, order id, etc.), subset of "columns".
- grainGuess: optional short phrase (e.g. "daily orders", "monthly revenue").
- notes: optional caveats (PII, mixed formats, fiscal year assumptions, etc.).

For each name in dirtyStringDateColumns, the pipeline will add a new column named Cleaned_<exact original header> with normalized values when possible.

Do not invent column names. Only use names from "columns".`;

/**
 * LLM inference on raw sample rows — intended to run before date canonicalization.
 */
export async function inferDatasetProfile(
  data: Record<string, any>[],
  options?: { fileName?: string; timeoutMs?: number }
): Promise<DatasetProfile> {
  if (!data.length) {
    return { ...emptyDatasetProfile(), shortDescription: 'No rows to analyze.' };
  }

  const timeoutMs =
    options?.timeoutMs ?? (Number(process.env.DATASET_PROFILE_TIMEOUT_MS) || 45_000);
  const payload = buildLlmPayload(data);
  const userContent = JSON.stringify({
    fileName: options?.fileName,
    ...payload,
  });

  const runLlm = async (): Promise<DatasetProfile> => {
    const result = await completeJson(
      SYSTEM_PROMPT,
      userContent,
      datasetProfileSchema,
      { maxTokens: 2048, temperature: 0.2, turnId: 'dataset_profile' }
    );
    if (!result.ok) {
      console.warn('⚠️ inferDatasetProfile: LLM parse failed:', result.error);
      return emptyDatasetProfile();
    }
    return result.data;
  };

  try {
    const winner = await Promise.race([
      runLlm(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (winner === null) {
      console.warn(`⚠️ inferDatasetProfile: timeout after ${timeoutMs}ms`);
      return emptyDatasetProfile();
    }
    return winner;
  } catch (e) {
    console.warn('⚠️ inferDatasetProfile:', e);
    return emptyDatasetProfile();
  }
}
