import {
  datasetProfileSchema,
  type DataSummary,
  type DatasetProfile,
} from '../shared/schema.js';
import { completeJson } from './agents/runtime/llmJson.js';
import { LLM_PURPOSE } from './agents/runtime/llmCallPurpose.js';
import { stripOrQuestions } from './suggestedQuestionGuard.js';
import { AMBIGUOUS_SYMBOLS } from './wideFormat/currencyVocabulary.js';
import { logger } from "./logger.js";

export type { DatasetProfile };
export { datasetProfileSchema };

export const emptyDatasetProfile = (): DatasetProfile => ({
  shortDescription: '',
  dateColumns: [],
  suggestedQuestions: [],
});

/**
 * Sample rows sent to the profiling LLM. Smaller = fewer input tokens = a
 * modestly faster call, at some risk to dirty-date / format detection (which
 * needs value variety). Env-tunable per deployment via
 * `DATASET_PROFILE_SAMPLE_ROWS`; default 60 is the proven value.
 *
 * NOTE (Wave W-DPC2): the profiling call already runs on the deployment's only
 * / fastest model (e.g. gpt-5.4-mini — PRIMARY and MINI tiers point at the same
 * deployment), so there is no faster model to route to. The dataset-profile
 * CACHE (Wave W-DPC1) — which skips this call entirely on re-uploads — is the
 * primary cold-path latency lever; this sample knob and `DATASET_PROFILE_TIMEOUT_MS`
 * are the only secondary, quality-trading knobs for the first-ever upload.
 */
const MAX_SAMPLE_ROWS = Number(process.env.DATASET_PROFILE_SAMPLE_ROWS) || 60;
const MAX_CELL_CHARS = 200;

function buildLlmPayload(data: Record<string, any>[]) {
  if (!data.length) {
    return { columns: [] as string[], sampleRows: [] as Record<string, unknown>[] };
  }
  const columns = Object.keys(data[0]!);
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
- shortDescription: 1–3 sentences describing what the dataset is about. If the dataset has been pre-melted from wide format (you'll see a "Period" / "PeriodIso" / "Value" column triple), describe it as period-over-period and mention the period range. If the dataset has BOTH a free-text "Period" column AND any "Day · ", "Week · ", "Month · ", "Quarter · ", "Half-year · " or "Year · " prefixed columns AND a "PeriodKind" discriminator, treat these as FACETS OF ONE TIME DIMENSION (not independent fields). When suggesting time-based questions, always specify a SINGLE grain (e.g. "monthly Sales Value trend", "quarterly distribution by region") — never propose questions that would combine multiple grains (e.g. mixing Q1_25 with Latest_12_Mths with YTD on one axis is a category error).
- dateColumns: every column that holds dates, datetimes, or business period labels that represent time (exact header names from "columns"). Include messy string encodings (e.g. "Q1 27-Feb '25", "H1 Q1", fiscal labels). If none, use []. Do not include identifier columns (row id, order id, etc.).
- dirtyStringDateColumns: subset of dateColumns where values in the sample are mostly plain strings (or mixed) and are NOT already ISO/standard datetimes or native timestamps in the sample — i.e. the column needs a cleaned parse pass. Columns where every non-null sample value is already an ISO-like datetime string or unambiguous standard format should NOT be listed here. If none need cleaning, use [].
- suggestedQuestions: exactly 5 short, concrete analytical questions a user might ask. Make them DECISION-RELEVANT, not flat "X by Y" descriptions a manager would already know: prefer COMPARISONS (which segment/brand/region/channel leads or trails on a key metric), MOVEMENTS (what changed and where), and OUTLIERS (what is unexpectedly high or low) — the questions whose answer would change a decision. Use the dataset's real business nouns from the actual column values, and when "domainContext" is provided and the headers borrow its vocabulary (brands, channels like GT/MT/Q-com, regions, KPIs), phrase questions in those terms. Do NOT include questions about identifier or key columns (those in idColumns — they are row keys, not dimensions). Do NOT ask "how does [date column] trend over time" — date columns are time axes; instead ask how a numeric metric changes over the date column. Each question MUST ask exactly ONE thing — NEVER combine clauses with "and"/"or" or list multiple dimensions (BAD: "give a data summary or anomalies", "how does X vary by ASM or HQ"); split any compound ask into separate single questions.
- measureColumns: names of numeric metric columns (revenue, quantity, etc.), subset of "columns".
- idColumns: identifier columns (customer id, order id, etc.), subset of "columns".
- grainGuess: optional short phrase (e.g. "daily orders", "monthly revenue").
- notes: optional caveats (PII, mixed formats, fiscal year assumptions, etc.).
- currencyOverrides: ONLY when "ambiguousCurrencyColumns" is non-empty. For each listed column, pick the most likely ISO 4217 code based on (a) market / region / brand values in other columns (e.g. "Off VN" → VND, "MARICO India" → INR, "USA West" → USD, "Stockholm" → SEK), (b) dataset shortDescription, (c) typical magnitudes (Vietnamese đồng amounts are usually in the billions, Japanese yen also large; CAD/USD/EUR/GBP smaller). Skip columns whose context is genuinely unclear. Use exactly 3-letter codes.
- perColumn: for EVERY column, its true SEMANTIC TYPE judged from the column NAME and the VALUES together (not value shape alone). Each entry is {name, semanticType, temporalGrain?}. Choose semanticType from EXACTLY these values:
  • temporal_date — a real calendar date/timestamp.
  • temporal_year — a year, EVEN when stored as a plain int (e.g. a "Year" column that is 26 meaning FY2026, or 2024). Never a measure.
  • temporal_month — a calendar month (a "Month" column, month names, or a single month-stamp). Set temporalGrain:"monthOrQuarter".
  • temporal_quarter — a quarter label like "Q1"/"H1". Set temporalGrain:"monthOrQuarter".
  • ordinal — a small integer POSITION/index/rank that must NEVER be averaged or summed (e.g. "fy_month_number"=1..12, a 1..5 rating, a rank).
  • identifier — a code / key / SKU / id (e.g. "Brand_Code"), high-cardinality or code-like; not a measure.
  • categorical_dimension — a text category to group by (e.g. "Channel"=GT/MT, "sub_channel_group").
  • measure_additive — a real numeric quantity that is meaningful to SUM (volume, units, revenue amount).
  • measure_ratio_percent — a ratio / percentage / rate / margin / share / scheme that must NEVER be summed (e.g. "Retailer Margin", "Primary Scheme", a "% ..." or a rate column). Only AVERAGE it.
  • measure_per_unit — a per-unit price / index / score that must not be summed (e.g. MRP per unit, ASP).
  • currency_amount — a monetary amount meaningful to sum.
  • boolean_flag — a yes/no / true-false indicator.
  • empty — the column is entirely blank in the sample.
  Be intelligent and use the header text: a column literally named "Year"/"Month"/"Quarter" is temporal even if its values look numeric or constant; a "…_number"/"…_no"/"rank" is ordinal, not a measure; a "…margin"/"…rate"/"…%"/"…scheme"/"…share" is a ratio, never summed. Only use names from "columns"; omit a column if genuinely unsure rather than guessing a measure. temporalGrain (one of "dayOrWeek"|"monthOrQuarter"|"year") is optional and only for temporal_* columns.

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
    /** Wave W-UD8 · optional sink that receives per-block truncation events
     *  for the upload-time permanentContext + domainContext caps. */
    contextTrimmedSink?: Array<{
      id: string;
      inputChars: number;
      outputChars: number;
      reason: "budget";
    }>;
  }
): Promise<DatasetProfile> {
  if (!data.length) {
    return { ...emptyDatasetProfile(), shortDescription: 'No rows to analyze.' };
  }

  // Non-blocking-startup cap. This profile call sits on the critical upload
  // path (it guides cleaning + suggestions), and on timeout it returns the
  // DETERMINISTIC emptyDatasetProfile() — which the heuristic date/column
  // detection downstream already handles. So a slow/unresponsive LLM
  // deployment shouldn't stall "ready to chat" for the old 45s; cap at 15s.
  // A healthy model returns this profile in a few seconds (well under the cap),
  // so the common path is unchanged. Env-tunable per deployment.
  const timeoutMs =
    options?.timeoutMs ?? (Number(process.env.DATASET_PROFILE_TIMEOUT_MS) || 15_000);
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
  //
  // Wave W-UD8 · `applyCap` records trim events on `options.trimmedSink`
  // so callers (e.g. upload pipeline) can forward them as a
  // `context_trimmed` SSE row.
  const { applyCap } = await import("./agents/runtime/promptBudget.js");
  const trimmedSink = options?.contextTrimmedSink;
  const pcRaw = options?.permanentContext?.trim();
  const dcRaw = options?.domainContext?.trim();
  // User-provided "Give Additional Context" — used in full, never capped.
  const permanentContext = pcRaw || undefined;
  // Authored FMCG/Marico packs stay bounded so the upload-time profile call
  // (which already carries the sample rows) can't balloon.
  const dcResult = dcRaw ? applyCap("datasetProfile.domainContext", dcRaw, 2000) : undefined;
  if (dcResult?.trimmed) trimmedSink?.push(dcResult.trimmed);
  const domainContext = dcResult?.content || undefined;
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
      logger.warn('⚠️ inferDatasetProfile: LLM parse failed:', result.error);
      return emptyDatasetProfile();
    }
    // `datasetProfileSchema` now uses z.preprocess on `notes`/`currencyOverrides`
    // (tolerant coercion), so its input type differs from its output type and
    // completeJson<T>(ZodType<T>) surfaces the input-shaped T. The runtime value
    // IS the validated output, so this cast is sound.
    const profile = result.data as DatasetProfile;
    // Backstop the prompt's no-"or" rule for the suggested starter questions.
    return {
      ...profile,
      suggestedQuestions: stripOrQuestions(profile.suggestedQuestions),
    };
  };

  try {
    const winner = await Promise.race([
      runLlm(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (winner === null) {
      logger.warn(`⚠️ inferDatasetProfile: timeout after ${timeoutMs}ms`);
      return emptyDatasetProfile();
    }
    return winner;
  } catch (e) {
    logger.warn('⚠️ inferDatasetProfile:', e);
    return emptyDatasetProfile();
  }
}
