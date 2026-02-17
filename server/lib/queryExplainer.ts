import { openai, MODEL } from "./openai.js";
import type { QueryResult } from "../shared/queryTypes.js";
import type { DataSummary, Insight } from "../shared/schema.js";
import type { DatasetProfile } from "./queryPlanner.js";

export interface ExplanationModeInput {
  userQuestion: string;
  queryResult: QueryResult;
  datasetProfile: DatasetProfile;
  dataSummary: DataSummary;
  chatInsights?: Insight[];
}

export interface ExplainResult {
  explanation: string;
  insights: Insight[];
}

/**
 * Parse explanation content into explanation text and key insights.
 * Expects optional "KEY INSIGHTS:" section at the end with 1-3 bullet lines.
 */
function parseExplanationAndInsights(content: string): ExplainResult {
  const keyInsightsMarker = "KEY INSIGHTS:";
  const idx = content.indexOf(keyInsightsMarker);
  let explanation = content.trim();
  const insights: Insight[] = [];

  if (idx !== -1) {
    explanation = content.slice(0, idx).trim();
    const afterMarker = content.slice(idx + keyInsightsMarker.length).trim();
    const lines = afterMarker
      .split(/\n/)
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 0);
    insights.push(
      ...lines.slice(0, 5).map((text, i) => ({ id: i + 1, text }))
    );
  }

  return { explanation, insights };
}

/**
 * Generate a natural-language explanation and 1-3 key insights for a structured query result.
 * The LLM ONLY sees compact aggregated results and dataset metadata – never raw full datasets.
 */
export async function explainQueryResultWithAI(
  input: ExplanationModeInput
): Promise<ExplainResult> {
  const { userQuestion, queryResult, datasetProfile, dataSummary, chatInsights } =
    input;

  const previewRowCount = Math.min(queryResult.rows.length, 50);
  const previewRows = queryResult.rows.slice(0, previewRowCount);

  const profileSummaryLines: string[] = [];
  profileSummaryLines.push(
    `Rows: ${datasetProfile.rowCount}, Columns: ${datasetProfile.columnCount}`
  );
  profileSummaryLines.push(
    `Columns: ${datasetProfile.columns
      .map((c) => `${c.name} [${c.type}]`)
      .join(", ")}`
  );
  if (datasetProfile.numericColumns.length > 0) {
    profileSummaryLines.push(
      `Numeric columns: ${datasetProfile.numericColumns.join(", ")}`
    );
  }
  if (datasetProfile.dateColumns.length > 0) {
    profileSummaryLines.push(
      `Date columns: ${datasetProfile.dateColumns.join(", ")}`
    );
  }

  const insightsText =
    chatInsights && chatInsights.length
      ? chatInsights
          .slice(0, 5)
          .map((ins) => `- ${ins.text}`)
          .join("\n")
      : "N/A";

  const diagnosticsText = queryResult.meta.diagnostics?.join("\n- ") || "N/A";

  const prompt = `You are a senior data analyst explaining results to a business stakeholder.

USER QUESTION:
"""
${userQuestion}
"""

DATASET PROFILE:
${profileSummaryLines.join("\n")}

EXISTING INSIGHTS (for context, optional):
${insightsText}

STRUCTURED QUERY RESULT (compact, aggregated data only):
- Action: ${queryResult.meta.action}
- GroupBy: ${queryResult.meta.groupBy?.join(", ") || "none"}
- Columns: ${queryResult.meta.columns.join(", ")}
- Row count: ${queryResult.meta.rowCount}
- Limit: ${queryResult.meta.limit ?? "none"}
- Diagnostics:
- ${diagnosticsText}

RESULT ROWS (preview, up to ${previewRowCount} rows):
${JSON.stringify(previewRows, null, 2)}

TASK:
1. Provide a clear, concise explanation that directly answers the user's question using ONLY the structured result above.
2. Do NOT speculate about data that is not present in the result rows.
3. Highlight the most important numbers, trends, or groups.
4. If the result is grouped, explain how groups compare.
5. If thresholds or filters were applied, mention them explicitly if visible from the result.
6. Keep the explanation focused and business-friendly.

Then, after a blank line, add exactly this line: KEY INSIGHTS:
Then list 1-3 short, actionable insights (one per line, each starting with "- "). Each insight should be one sentence about what the user asked (e.g. "Top category X accounts for Y% of Z" or "The trend shows a Z% increase over the period").

CRITICAL:
- Do NOT ask the user questions.
- Do NOT mention that you only saw partial data – speak confidently based on the result you see.
- Do NOT output JSON in the main explanation. Only use "KEY INSIGHTS:" and bullet lines for the insights section.`;

  const response = await openai.chat.completions.create({
    model: MODEL as string,
    messages: [
      {
        role: "system",
        content:
          "You are a senior analytics copilot. You receive compact aggregated query results and explain them clearly in natural language, then add KEY INSIGHTS: and 1-3 bullet insights.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 800,
  });

  const content = response.choices[0]?.message?.content?.trim() || "";
  return parseExplanationAndInsights(content);
}

