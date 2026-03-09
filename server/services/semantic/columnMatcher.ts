import { openai, MODEL } from "../../lib/openai.js";
import type { DatasetProfile } from "../../lib/queryPlanner.js";
import type { DataSummary } from "../../shared/schema.js";

export interface MatchRelevantColumnsParams {
  question: string;
  datasetProfile: DatasetProfile;
  dataSummary: DataSummary;
  datasetSemantics?: string | null;
}

export interface MatchRelevantColumnsResult {
  matchedColumns: string[];
  reasoning?: string;
}

/**
 * LLM-based semantic column matcher.
 *
 * This replaces any regex-style column extraction for *semantic* understanding
 * of the question. The model sees:
 * - Dataset columns and types
 * - Column statistics / sample values
 * - Overall dataset summary + semantics
 * - The user question in natural language
 */
export async function matchRelevantColumns(
  params: MatchRelevantColumnsParams
): Promise<MatchRelevantColumnsResult> {
  const { question, datasetProfile, dataSummary, datasetSemantics } = params;

  const columnsDesc = datasetProfile.columns
    .map(
      (c) =>
        `- ${c.name} [${c.type}] samples=${JSON.stringify(
          c.sampleValues
        ).slice(0, 80)}`
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
You are a semantic column matcher for an analytics engine.

USER QUESTION:
"""
${question}
"""

DATASET OVERVIEW:
- Rows: ${datasetProfile.rowCount}
- Columns: ${datasetProfile.columnCount}

COLUMNS:
${columnsDesc}

COLUMN STATISTICS (if available, truncated):
${statsSnippet}

DATASET SUMMARY (if available):
- Numeric columns: ${dataSummary.numericColumns.join(", ") || "None"}
- Date columns: ${dataSummary.dateColumns.join(", ") || "None"}

DATASET SEMANTICS (if available, truncated):
${semanticsSnippet}

TASK:
- Identify which dataset columns are SEMANTICALLY relevant to the user's question.
- You MUST use only existing column names.
- Match synonyms and paraphrases, for example:
  - "people who left", "employees who quit", "attrition" → resignation/termination-related columns
  - "headcount", "employees", "staff" → employee identifier / row-level columns
  - "department", "team", "business unit" → department/team-like columns
- If no columns are clearly relevant, return an empty list.

OUTPUT STRICT JSON (no markdown):
{
  "matchedColumns": ["col1", "col2", ...],
  "reasoning": "short explanation of why these columns are relevant"
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a semantic column matcher for tabular analytics. Respond ONLY with valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { matchedColumns: [] };
    }

    const parsed = JSON.parse(content);
    const matchedColumns: string[] = Array.isArray(parsed.matchedColumns)
      ? parsed.matchedColumns.map((c: any) => String(c)).filter(Boolean)
      : [];

    return {
      matchedColumns,
      reasoning:
        typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
    };
  } catch (error) {
    console.error("❌ matchRelevantColumns failed:", error);
    return { matchedColumns: [] };
  }
}

