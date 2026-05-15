import {
  datasetProfileSchema,
  type DataSummary,
  type DatasetProfile,
} from '../shared/schema.js';
import { completeJson } from './agents/runtime/llmJson.js';
import { LLM_PURPOSE } from './agents/runtime/llmCallPurpose.js';
import { AMBIGUOUS_SYMBOLS } from './wideFormat/currencyVocabulary.js';

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

const SYSTEM_PROMPT = `You are a data analyst. You receive JSON with "columns" (header names in order), "sampleRows" (up to 100 raw rows — values may be messy: mixed date formats, text, numbers), optionally "ambiguousCurrencyColumns" listing numeric columns whose currency symbol is ambiguous (e.g. "$" could be USD / CAD / AUD / SGD / HKD; "kr" could be SEK / DKK / NOK; "¥" could be JPY or CNY), optionally "userContext" (verbatim notes the user set on the session — apply when describing the dataset and choosing suggested questions; standing instructions like "always exclude Central region" should NOT override the schema but SHOULD influence which questions you suggest), and optionally "domainContext" (FMCG / Marico domain vocabulary — use only to resolve metric/dimension names the dataset's column headers borrow from this vocabulary, NEVER to invent fields not present in "columns").

Return ONLY a JSON object with these keys:
- shortDescription: 1–3 sentences describing what the dataset is about. If the dataset has been pre-melted from wide format (you'll see a "Period" / "PeriodIso" / "Value" column triple), describe it as period-over-period and mention the period range.
- dateColumns: every column that holds dates, datetimes, or business period labels that represent time (exact header names from "columns"). Include messy string encodings (e.g. "Q1 27-Feb '25", "H1 Q1", fiscal labels). If none, use []. Do not include identifier columns (row id, order id, etc.).
- dirtyStringDateColumns: subset of dateColumns where values in the sample are mostly plain strings (or mixed) and are NOT already ISO/standard datetimes or native timestamps in the sample — i.e. the column needs a cleaned parse pass. Columns where every non-null sample value is already an ISO-like datetime string or unambiguous standard format should NOT be listed here. If none need cleaning, use [].
- suggestedQuestions: 5–8 short, concrete analytical questions a user might ask. Do NOT include questions about identifier or key columns (those in idColumns — they are row keys, not dimensions). Do NOT ask "how does [date column] trend over time" — date columns are time axes; instead ask how a numeric metric changes over the date column.
- measureColumns: names of numeric metric columns (revenue, quantity, etc.), subset of "columns".
- idColumns: identifier columns (customer id, order id, etc.), subset of "columns".
- grainGuess: optional short phrase (e.g. "daily orders", "monthly revenue").
- notes: optional caveats (PII, mixed formats, fiscal year assumptions, etc.).
- currencyOverrides: ONLY when "ambiguousCurrencyColumns" is non-empty. For each listed column, pick the most likely ISO 4217 code based on (a) market / region / brand values in other columns (e.g. "Off VN" → VND, "MARICO India" → INR, "USA West" → USD, "Stockholm" → SEK), (b) dataset shortDescription, (c) typical magnitudes (Vietnamese đồng amounts are usually in the billions, Japanese yen also large; CAD/USD/EUR/GBP smaller). Skip columns whose context is genuinely unclear. Use exactly 3-letter codes.

For each name in dirtyStringDateColumns, the pipeline will add a new column named Cleaned_<exact original header> with normalized values when possible.

Do not invent column names. Only use names from "columns".`;

/**
 * LLM inference on raw sample rows — intended to run before date canonicalization.
 *
 * Pass `dataSummary` to enable currency-symbol disambiguation (WF8):
 * columns whose detected symbol is ambiguous (`$`, `kr`, `¥`) are
 * surfaced to the LLM so it can pick a 3-letter ISO code from
 * context. The override is returned in `currencyOverrides`.
 *
 * Wave B5 · Optionally pass `permanentContext` and/or `domainContext` so
 * the LLM has more signal to (a) describe the dataset in the user's own
 * terms, (b) pick currency overrides for ambiguous symbols, (c) suggest
 * questions that align with the user's stated interests and the
 * relevant FMCG/Marico domain vocabulary.
 *
 * Both blocks are OPTIONAL. The upload-pipeline caller passes them when
 * the chat doc already has permanentContext set (re-uploads / user has
 * declared standing context before uploading) and always passes the
 * process-memoised domainContext.
 */
export async function inferDatasetProfile(
  data: Record<string, any>[],
  options?: {
    fileName?: string;
    timeoutMs?: number;
    dataSummary?: DataSummary;
    /** Wave B5 · user's free-text notes from the "Add additional context" UI. */
    permanentContext?: string;
    /** Wave B5 · composed FMCG/Marico domain pack text from loadEnabledDomainContext. */
    domainContext?: string;
  }
): Promise<DatasetProfile> {
  if (!data.length) {
    return { ...emptyDatasetProfile(), shortDescription: 'No rows to analyze.' };
  }

  const timeoutMs =
    options?.timeoutMs ?? (Number(process.env.DATASET_PROFILE_TIMEOUT_MS) || 45_000);
  const payload = buildLlmPayload(data);
  const ambiguousCurrencyColumns: string[] = [];
  if (options?.dataSummary) {
    for (const c of options.dataSummary.columns) {
      if (c.currency && AMBIGUOUS_SYMBOLS.has(c.currency.symbol)) {
        ambiguousCurrencyColumns.push(c.name);
      }
    }
  }
  // Wave B5 · Cap each context block tightly because the profile call is
  // run at upload time on a payload that already includes the sample
  // rows; we don't want it to balloon. The values are passed alongside
  // the JSON payload as labelled string fields rather than as separate
  // sections, so the LLM reads them as part of the same input doc.
  const permanentContext = options?.permanentContext?.trim().slice(0, 800) || undefined;
  const domainContext = options?.domainContext?.trim().slice(0, 2000) || undefined;
  const userContent = JSON.stringify({
    fileName: options?.fileName,
    ...payload,
    ...(ambiguousCurrencyColumns.length > 0
      ? { ambiguousCurrencyColumns }
      : {}),
    ...(permanentContext ? { userContext: permanentContext } : {}),
    ...(domainContext ? { domainContext } : {}),
  });

  const runLlm = async (): Promise<DatasetProfile> => {
    const result = await completeJson(
      SYSTEM_PROMPT,
      userContent,
      datasetProfileSchema,
      { maxTokens: 2048, temperature: 0.2, turnId: 'dataset_profile', purpose: LLM_PURPOSE.DATASET_PROFILE }
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
