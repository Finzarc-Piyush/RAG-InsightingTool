import { openai, MODEL } from "../../lib/openai.js";
import type { DatasetProfile } from "../../lib/queryPlanner.js";
import type { DataSummary } from "../../shared/schema.js";
import type { BusinessSemanticIntent } from "./businessInterpreter.js";
import { BUSINESS_METRICS_SYSTEM_PROMPT } from "../../prompts/businessMetricsPrompt.js";

export type MetricType = "aggregation" | "derived_metric" | "ratio" | "time_trend" | "unknown";

export interface MetricDefinition {
  metricType: MetricType;
  aggregation?: "sum" | "avg" | "count" | "min" | "max";
  column?: string;
  condition?: string;
  formula?: string;
  requiredColumns: string[];
  explanation?: string;
}

export interface ResolveMetricParams {
  semanticIntent: BusinessSemanticIntent;
  datasetProfile: DatasetProfile;
  dataSummary: DataSummary;
  datasetSemantics?: string | null;
}

/**
 * Resolve a high-level business metric (e.g. "attrition_rate", "resignations")
 * into a concrete dataset-level metric definition (columns + formula).
 *
 * This is entirely LLM-based – NO hard-coded column names or regexes.
 */
export async function resolveBusinessMetric(
  params: ResolveMetricParams
): Promise<MetricDefinition | null> {
  const { semanticIntent, datasetProfile, datasetSummary, datasetSemantics } = {
    semanticIntent: params.semanticIntent,
    datasetProfile: params.datasetProfile,
    datasetSummary: params.dataSummary,
    datasetSemantics: params.datasetSemantics,
  };

  if (!semanticIntent.businessMetric) {
    return null;
  }

  const columnsDesc = datasetProfile.columns
    .map(
      (c) =>
        `- ${c.name} [${c.type}] samples=${JSON.stringify(
          c.sampleValues
        ).slice(0, 120)}`
    )
    .join("\n");

  const statsSnippet = datasetProfile.columnStatistics
    ? JSON.stringify(datasetProfile.columnStatistics).slice(0, 2000)
    : "N/A";

  const semanticsSnippet =
    datasetSemantics && datasetSemantics.trim().length > 0
      ? datasetSemantics.trim().slice(0, 1500)
      : "N/A";

  const prompt = `
${BUSINESS_METRICS_SYSTEM_PROMPT}

BUSINESS METRIC TO RESOLVE:
- businessMetric: "${semanticIntent.businessMetric}"
- highLevelIntent: "${semanticIntent.intent}"
- dimensions: ${JSON.stringify(semanticIntent.dimensions)}
- filters: ${JSON.stringify(semanticIntent.filters)}
- timeContext: ${JSON.stringify(semanticIntent.timeContext)}

DATASET OVERVIEW:
- Rows: ${datasetProfile.rowCount}
- Columns: ${datasetProfile.columnCount}

COLUMNS:
${columnsDesc}

COLUMN STATISTICS (if available, truncated):
${statsSnippet}

DATASET SEMANTICS (if available, truncated):
${semanticsSnippet}

TASK:
- Map the businessMetric to concrete dataset columns and a precise formula.
- You MUST use ONLY existing columns.
- Prefer clear, explainable definitions.
- When you define a "condition", you MUST build it from the actual sample values shown for that column.
  - For example, if a column "Resigned?" has samples [1, 0], you should use conditions like "Resigned? = 1".
  - Do NOT invent values like "Yes"/"No" unless those exact strings appear in the samples.
- If a boolean/flag column seems to represent "resigned" / "left" / "terminated", use its literal sample values in the condition.
- If a date column clearly represents resignation, you may treat non-null values as resignations (e.g. "resignation_date IS NOT NULL").
- If a unique identifier column appears (e.g. employee_id), use it for denominators/headcount.

OUTPUT STRICT JSON (no markdown, no comments):
{
  "metricType": "aggregation" | "derived_metric" | "ratio" | "time_trend" | "unknown",
  "aggregation": "sum" | "avg" | "count" | "min" | "max" | null,
  "column": "name of primary column used for aggregation or counting, if any",
  "condition": "optional row-level condition in pseudo-code, e.g. 'resigned == true' or 'resignation_date IS NOT NULL'",
  "formula": "string description of how to compute the metric using columns (pseudo-SQL or math), if derived",
  "requiredColumns": ["list", "of", "column", "names"],
  "explanation": "short natural language explanation of how this metric is computed"
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a metric resolver that maps business metrics onto concrete dataset columns. Respond ONLY with valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 700,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return null;
    }

    const raw = JSON.parse(content);

    const requiredColumns: string[] = Array.isArray(raw.requiredColumns)
      ? raw.requiredColumns.map((c: any) => String(c)).filter(Boolean)
      : [];

    const def: MetricDefinition = {
      metricType: (raw.metricType || "unknown") as MetricType,
      aggregation:
        raw.aggregation && typeof raw.aggregation === "string"
          ? (raw.aggregation as MetricDefinition["aggregation"])
          : undefined,
      column: raw.column ? String(raw.column) : undefined,
      condition: raw.condition ? String(raw.condition) : undefined,
      formula: raw.formula ? String(raw.formula) : undefined,
      requiredColumns,
      explanation:
        typeof raw.explanation === "string" ? raw.explanation : undefined,
    };

    return def;
  } catch (error) {
    console.error("❌ resolveBusinessMetric failed:", error);
    return null;
  }
}

