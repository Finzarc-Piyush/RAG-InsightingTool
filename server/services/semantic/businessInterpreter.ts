import { openai, MODEL } from "../../lib/openai.js";
import type { DatasetProfile } from "../../lib/queryPlanner.js";
import type { DataSummary } from "../../shared/schema.js";
import { BUSINESS_METRICS_SYSTEM_PROMPT } from "../../prompts/businessMetricsPrompt.js";

export type SemanticIntentType =
  | "metric_query"
  | "trend_analysis"
  | "comparison"
  | "distribution"
  | "ranking"
  | "unknown";

export interface BusinessSemanticIntent {
  intent: SemanticIntentType;
  businessMetric: string | null;
  dimensions: string[];
  filters: Array<{
    dimension: string;
    operator: string;
    value: string | number | boolean | null;
  }>;
  timeContext: string | null;
  confidence: number;
  reasoning?: string;
}

export interface InterpretBusinessQuestionParams {
  question: string;
  datasetProfile: DatasetProfile;
  dataSummary: DataSummary;
  datasetSemantics?: string | null;
}

/**
 * Interpret a manager-style business question into a semantic intent structure.
 *
 * This is intentionally LLM-driven – there are no regexes or hard-coded
 * mappings to column names. The model sees:
 * - Dataset columns and types
 * - Column statistics (if available)
 * - Data summary
 * - Optional high-level dataset semantics
 */
export async function interpretBusinessQuestion(
  params: InterpretBusinessQuestionParams
): Promise<BusinessSemanticIntent | null> {
  const { question, datasetProfile, dataSummary, datasetSemantics } = params;

  const columnsDesc = datasetProfile.columns
    .map((c) => `- ${c.name} [${c.type}] samples=${JSON.stringify(c.sampleValues).slice(0, 120)}`)
    .join("\n");

  const numericCols =
    datasetProfile.numericColumns.length > 0
      ? datasetProfile.numericColumns.join(", ")
      : "None";
  const dateCols =
    datasetProfile.dateColumns.length > 0
      ? datasetProfile.dateColumns.join(", ")
      : "None";

  const statsSnippet = datasetProfile.columnStatistics
    ? JSON.stringify(datasetProfile.columnStatistics).slice(0, 2000)
    : "N/A";

  const semanticsSnippet =
    datasetSemantics && datasetSemantics.trim().length > 0
      ? datasetSemantics.trim().slice(0, 1500)
      : "N/A";

  const prompt = `
${BUSINESS_METRICS_SYSTEM_PROMPT}

USER QUESTION (manager / business language):
"""
${question}
"""

DATASET OVERVIEW:
- Rows: ${datasetProfile.rowCount}
- Columns: ${datasetProfile.columnCount}

COLUMNS:
${columnsDesc}

NUMERIC COLUMNS: ${numericCols}
DATE COLUMNS: ${dateCols}

COLUMN STATISTICS (if available, truncated):
${statsSnippet}

DATASET SEMANTICS (if available, truncated):
${semanticsSnippet}

TASK:
- Interpret the question as a business/analytics intent.
- Do NOT guess actual SQL or column names here; focus on semantic meaning.
- Identify the primary business metric being asked about (e.g. "attrition_rate", "resignations",
  "employee_count", "revenue", "churn_rate", etc.).
- Identify high-level intent:
  - "metric_query": a single KPI at a point in time (e.g. "How many people resigned?")
  - "trend_analysis": evolution over time (e.g. "Is attrition increasing?")
  - "comparison": comparisons across categories (e.g. departments, regions)
  - "distribution": distribution across categories or buckets
  - "ranking": top/bottom style questions (e.g. "Which department has highest attrition?")
- Identify which conceptual dimensions are involved (e.g. "department", "team", "region", "time").
- Identify any explicit or implicit filters (e.g. "last year", "in sales department").
- Identify the time context if present (e.g. "last 6 months", "2023 only").

OUTPUT STRICT JSON (no markdown, no extra fields):
{
  "intent": "metric_query | trend_analysis | comparison | distribution | ranking | unknown",
  "businessMetric": "string | null",
  "dimensions": ["list", "of", "dimension", "concepts"],
  "filters": [
    {
      "dimension": "conceptual_dimension_name",
      "operator": "== | != | > | < | >= | <= | in | contains | between | startswith | endswith",
      "value": "string | number | boolean | null"
    }
  ],
  "timeContext": "string or null",
  "confidence": 0.0-1.0,
  "reasoning": "short natural language explanation"
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a semantic business-intent interpreter for analytics questions. Respond ONLY with valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content);

    const intent: BusinessSemanticIntent = {
      intent: (parsed.intent ||
        "unknown") as SemanticIntentType,
      businessMetric: parsed.businessMetric ?? null,
      dimensions: Array.isArray(parsed.dimensions)
        ? parsed.dimensions.map((d: any) => String(d)).filter(Boolean)
        : [],
      filters: Array.isArray(parsed.filters)
        ? parsed.filters.map((f: any) => ({
            dimension: String(f.dimension ?? ""),
            operator: String(f.operator ?? ""),
            value:
              typeof f.value === "string" ||
              typeof f.value === "number" ||
              typeof f.value === "boolean" ||
              f.value === null
                ? f.value
                : String(f.value),
          }))
        : [],
      timeContext: parsed.timeContext ?? null,
      confidence:
        typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      reasoning:
        typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
    };

    return intent;
  } catch (error) {
    console.error("❌ interpretBusinessQuestion failed:", error);
    return null;
  }
}

