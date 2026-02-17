import { openai, MODEL } from "./openai.js";
import type { ChatDocument } from "../models/chat.model.js";
import type { DataSummary } from "../shared/schema.js";
import {
  QueryPlan,
  QueryFilter,
  QueryAggregation,
  QuerySortBy,
  QueryResult,
  QueryAction,
  QueryFilterOperator,
  QueryAggregationType,
} from "../shared/queryTypes.js";

export interface DatasetProfile {
  rowCount: number;
  columnCount: number;
  columns: Array<{
    name: string;
    type: string;
    sampleValues: Array<string | number | null>;
  }>;
  numericColumns: string[];
  dateColumns: string[];
  // Column-level statistics when available
  columnStatistics?: Record<
    string,
    {
      count?: number;
      min?: number;
      max?: number;
      sum?: number;
      mean?: number;
    } & Record<string, unknown>
  >;
  // Optional detailed statistics from Python service
  dataSummaryStatistics?: ChatDocument["dataSummaryStatistics"];
}

export interface PlannerInput {
  userQuestion: string;
  chatDocument: ChatDocument;
}

export interface QueryPlanError {
  code: "PLANNING_ERROR" | "VALIDATION_ERROR" | "PARSING_ERROR";
  message: string;
  details?: unknown;
}

export interface PlanResult {
  queryPlan?: QueryPlan;
  error?: QueryPlanError;
  rawResponse?: string;
}

const ALLOWED_ACTIONS: QueryAction[] = [
  "aggregate",
  "filter",
  "groupby",
  "topk",
  "row_lookup",
];

const ALLOWED_OPERATORS: QueryFilterOperator[] = [
  "=",
  ">",
  "<",
  ">=",
  "<=",
  "!=",
  "contains",
];

const ALLOWED_AGG_TYPES: QueryAggregationType[] = [
  "sum",
  "avg",
  "count",
  "min",
  "max",
];

export function buildDatasetProfile(chat: ChatDocument): DatasetProfile {
  const summary: DataSummary = chat.dataSummary;
  return {
    rowCount: summary.rowCount,
    columnCount: summary.columnCount,
    columns: summary.columns,
    numericColumns: summary.numericColumns,
    dateColumns: summary.dateColumns,
    columnStatistics: chat.columnStatistics || undefined,
    dataSummaryStatistics: chat.dataSummaryStatistics,
  };
}

function sanitiseQueryPlan(
  raw: any,
  profile: DatasetProfile
): { plan?: QueryPlan; error?: QueryPlanError } {
  if (!raw || typeof raw !== "object") {
    return {
      error: {
        code: "VALIDATION_ERROR",
        message: "Planner response is not a JSON object.",
        details: raw,
      },
    };
  }

  const allowedColumns = new Set(profile.columns.map((c) => c.name));

  const action: QueryAction = ALLOWED_ACTIONS.includes(raw.action)
    ? raw.action
    : "aggregate";

  const filters: QueryFilter[] = Array.isArray(raw.filters)
    ? raw.filters
        .map((f: any) => {
          if (!f || typeof f !== "object") return null;
          if (!allowedColumns.has(f.column)) return null;
          if (!ALLOWED_OPERATORS.includes(f.operator)) return null;
          return {
            column: String(f.column),
            operator: f.operator as QueryFilterOperator,
            value:
              typeof f.value === "number" ||
              typeof f.value === "string" ||
              typeof f.value === "boolean" ||
              f.value === null
                ? f.value
                : String(f.value),
          } as QueryFilter;
        })
        .filter((f: QueryFilter | null): f is QueryFilter => Boolean(f))
    : [];

  const aggregations: QueryAggregation[] = Array.isArray(raw.aggregations)
    ? raw.aggregations
        .map((a: any) => {
          if (!a || typeof a !== "object") return null;
          if (!allowedColumns.has(a.column)) return null;
          if (!ALLOWED_AGG_TYPES.includes(a.type)) return null;
          return {
            column: String(a.column),
            type: a.type as QueryAggregationType,
          } as QueryAggregation;
        })
        .filter(
          (a: QueryAggregation | null): a is QueryAggregation => Boolean(a)
        )
    : [];

  const groupBy: string[] = Array.isArray(raw.groupBy)
    ? raw.groupBy
        .map((g: any) => String(g))
        .filter((g: string) => allowedColumns.has(g))
    : [];

  let sortBy: QuerySortBy | undefined;
  if (raw.sortBy && typeof raw.sortBy === "object") {
    const col = String(raw.sortBy.column);
    const dir = raw.sortBy.direction === "desc" ? "desc" : "asc";
    if (allowedColumns.has(col)) {
      sortBy = { column: col, direction: dir };
    }
  }

  let limit: number | undefined;
  if (typeof raw.limit === "number" && Number.isFinite(raw.limit)) {
    const n = Math.max(1, Math.floor(raw.limit));
    // Hard safety cap to avoid accidental massive result sets
    limit = Math.min(n, 10000);
  }

  const requiresFullScanRaw =
    typeof raw.requiresFullScan === "boolean"
      ? raw.requiresFullScan
      : undefined;

  const plan: QueryPlan = {
    action,
    filters,
    aggregations,
    groupBy,
    sortBy,
    limit,
    requiresFullScan: requiresFullScanRaw,
  };

  return { plan };
}

function inferRequiresFullScan(
  plan: QueryPlan,
  question: string,
  profile: DatasetProfile
): boolean {
  const lower = question.toLowerCase();

  // Explicit metadata-only questions
  const metadataPatterns = [
    "how many rows",
    "number of rows",
    "row count",
    "total rows",
    "total number of rows",
    "how many columns",
    "number of columns",
    "column count",
    "list of columns",
    "what columns",
  ];
  if (metadataPatterns.some((p) => lower.includes(p))) {
    return false;
  }

  // Pure metadata aggregations with no filters / groupBy
  if (plan.filters.length === 0 && plan.groupBy.length === 0) {
    const hasAggs = plan.aggregations.length > 0;
    if (!hasAggs) {
      // No filters, no groupBy, no aggregations → treat as metadata-only
      return false;
    }

    const canAllAggsUseStats = plan.aggregations.every((agg) => {
      if (agg.type === "count") {
        return true; // Always available from rowCount
      }
      const colStats = profile.columnStatistics?.[agg.column];
      if (!colStats) return false;
      switch (agg.type) {
        case "sum":
          return typeof colStats.sum === "number";
        case "avg":
          return typeof colStats.mean === "number";
        case "min":
          return typeof colStats.min === "number";
        case "max":
          return typeof colStats.max === "number";
        default:
          return false;
      }
    });

    if (canAllAggsUseStats) {
      return false;
    }
  }

  return true;
}

async function callPlannerLLM(
  input: PlannerInput,
  profile: DatasetProfile,
  previousError?: QueryPlanError
): Promise<{ rawJson?: any; rawText?: string; error?: QueryPlanError }> {
  const { userQuestion, chatDocument } = input;

  const profileSummaryLines: string[] = [];
  profileSummaryLines.push(
    `Rows: ${profile.rowCount}, Columns: ${profile.columnCount}`
  );
  profileSummaryLines.push(
    `Columns: ${profile.columns
      .map((c) => `${c.name} [${c.type}]`)
      .join(", ")}`
  );
  if (profile.numericColumns.length > 0) {
    profileSummaryLines.push(
      `Numeric columns: ${profile.numericColumns.join(", ")}`
    );
  }
  if (profile.dateColumns.length > 0) {
    profileSummaryLines.push(
      `Date columns: ${profile.dateColumns.join(", ")}`
    );
  }

  const retryNote = previousError
    ? `\nIMPORTANT: Your previous response was invalid because: ${previousError.message}. Fix it by strictly following the JSON schema and using ONLY the allowed columns and operators.\n\nALLOWED COLUMNS:\n${profile.columns
        .map((c) => `- ${c.name} [${c.type}]`)
        .join("\n")}\n\nALLOWED FILTER OPERATORS: ${ALLOWED_OPERATORS.join(
        ", "
      )}\nALLOWED AGGREGATION TYPES: ${ALLOWED_AGG_TYPES.join(", ")}\n`
    : "";

  const prompt = `You are a strict query planner for a data analytics system.
You must translate the user's natural language question into a structured query plan JSON.

DATASET PROFILE:
${profileSummaryLines.join("\n")}

DATA SUMMARY STATISTICS (if available):
${chatDocument.dataSummaryStatistics ? JSON.stringify(chatDocument.dataSummaryStatistics).slice(0, 2000) : "N/A"}

USER QUESTION:
"""
${userQuestion}
"""

TASK:
- Use ONLY the columns listed in the dataset profile.
- Decide what kind of operation is needed:
  - "aggregate": numeric aggregations like sum, avg, count, min, max.
  - "filter": row-level filtering only.
  - "groupby": grouping with aggregations.
  - "topk": top/bottom style queries using sort + limit.
  - "row_lookup": when the user explicitly asks for raw rows or details.
- NEVER return natural language. Return STRICT JSON only.
- If the question is metadata-only (e.g. total rows, number of columns, global min/max/avg without filters), set "requiresFullScan" to false.
- Otherwise, set "requiresFullScan" to true when row-level access is required.

JSON SCHEMA (no comments, all fields required but arrays may be empty):
{
  "action": "aggregate" | "filter" | "groupby" | "topk" | "row_lookup",
  "filters": [
    {
      "column": string,
      "operator": "=" | ">" | "<" | ">=" | "<=" | "!=" | "contains",
      "value": string | number
    }
  ],
  "aggregations": [
    {
      "column": string,
      "type": "sum" | "avg" | "count" | "min" | "max"
    }
  ],
  "groupBy": string[],
  "sortBy": {
    "column": string,
    "direction": "asc" | "desc"
  } | null,
  "limit": number | null,
  "requiresFullScan": boolean
}

CRITICAL RULES:
- Use only the provided column names exactly as given.
- Do not invent new columns.
- If no sorting/limit is needed, set "sortBy": null and "limit": null.
- Do not include any extra top-level fields.
- Do not wrap in markdown or backticks.
${retryNote}

Return ONLY a single JSON object conforming to the schema above.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON query planner. You MUST respond with valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 600,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        error: {
          code: "PLANNING_ERROR",
          message: "Planner returned empty content.",
        },
      };
    }

    let rawJson: any;
    try {
      rawJson = JSON.parse(content);
    } catch (parseError) {
      return {
        rawText: content,
        error: {
          code: "PARSING_ERROR",
          message: "Failed to parse planner JSON.",
          details: content,
        },
      };
    }

    return { rawJson, rawText: content };
  } catch (err) {
    console.error("❌ Query planner LLM call failed:", err);
    return {
      error: {
        code: "PLANNING_ERROR",
        message:
          err instanceof Error ? err.message : "Unknown error calling planner LLM",
      },
    };
  }
}

/**
 * Main entry point: plan a query using the LLM, with one retry on validation error.
 */
export async function planQueryWithAI(input: PlannerInput): Promise<PlanResult> {
  const profile = buildDatasetProfile(input.chatDocument);

  // First attempt
  const first = await callPlannerLLM(input, profile);
  if (first.error && !first.rawJson) {
    return { error: first.error, rawResponse: first.rawText };
  }

  let validation = sanitiseQueryPlan(first.rawJson, profile);
  if (!validation.plan) {
    // Retry once with clarification
    const retry = await callPlannerLLM(input, profile, validation.error);
    if (retry.error && !retry.rawJson) {
      return { error: retry.error, rawResponse: retry.rawText };
    }
    validation = sanitiseQueryPlan(retry.rawJson, profile);
    if (!validation.plan) {
      return {
        error: validation.error || {
          code: "VALIDATION_ERROR",
          message: "Planner produced invalid plan after retry.",
        },
        rawResponse: retry.rawText,
      };
    }
  }

  const plan = validation.plan;
  const requiresFullScan = inferRequiresFullScan(
    plan,
    input.userQuestion,
    profile
  );
  plan.requiresFullScan = requiresFullScan;

  return {
    queryPlan: plan,
    rawResponse: first.rawText,
  };
}

/**
 * Helper to construct a minimal QueryResult for metadata-only responses
 * (e.g. total row count) using dataset profile, without touching raw rows.
 */
export function buildMetadataOnlyResult(
  plan: QueryPlan,
  profile: DatasetProfile
): QueryResult {
  const rows: Array<Record<string, string | number | boolean | null>> = [];

  if (
    plan.aggregations.length === 0 &&
    plan.filters.length === 0 &&
    plan.groupBy.length === 0
  ) {
    // Default metadata: row and column counts
    rows.push({
      rowCount: profile.rowCount,
      columnCount: profile.columnCount,
    });
  }

  return {
    rows,
    meta: {
      rowCount: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      action: plan.action,
      groupBy: plan.groupBy.length ? plan.groupBy : undefined,
      sortBy: plan.sortBy,
      limit: plan.limit,
      diagnostics: [
        "Metadata-only result generated from dataset profile; no raw rows were scanned.",
      ],
    },
  };
}

