import { z } from 'zod';
import { completeJson } from './agents/runtime/llmJson.js';

export const datasetProfileSchema = z.object({
  shortDescription: z.string(),
  dateColumns: z.array(z.string()),
  suggestedQuestions: z.array(z.string()).max(8),
  measureColumns: z.array(z.string()).optional(),
  idColumns: z.array(z.string()).optional(),
  grainGuess: z.string().optional(),
  notes: z.string().optional(),
});

export type DatasetProfile = z.infer<typeof datasetProfileSchema>;

export const emptyDatasetProfile = (): DatasetProfile => ({
  shortDescription: '',
  dateColumns: [],
  suggestedQuestions: [],
});

const MAX_SAMPLE_ROWS = 100;
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
- dateColumns: array of column names that hold dates or datetimes (must be a subset of "columns"; empty array if none).
- suggestedQuestions: 5–8 short, concrete questions the user might ask about this data.
- measureColumns: names of numeric metric columns (revenue, quantity, etc.), subset of "columns".
- idColumns: identifier columns (customer id, order id, etc.), subset of "columns".
- grainGuess: optional short phrase (e.g. "daily orders", "monthly revenue").
- notes: optional caveats (PII, mixed formats, etc.).

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
