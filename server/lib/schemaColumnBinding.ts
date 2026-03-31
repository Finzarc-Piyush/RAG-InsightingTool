/**
 * Schema-aware column binding for the agentic path: maps natural-language questions
 * to exact DataSummary column names (no row filtering — fast path).
 */
import type { DataSummary, Message } from "../shared/schema.js";
import { openai, MODEL } from "./openai.js";
import { resolveToSchemaColumn } from "./agents/runtime/plannerColumnResolve.js";

export interface SchemaColumnBindingResult {
  /** Exact names present in `summary.columns` */
  canonicalColumns: string[];
  /** Natural phrases → exact schema column */
  columnMapping: Record<string, string>;
  reasoning: string;
}

function toCanonical(
  raw: string,
  columns: readonly { name: string }[]
): string | null {
  const r = resolveToSchemaColumn(raw, columns);
  return columns.some((c) => c.name === r) ? r : null;
}

function dedupeCanonical(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * LLM identifies implied columns; outputs are normalized through `resolveToSchemaColumn`
 * so only valid schema names are returned.
 */
export async function bindSchemaColumnsForAgentic(
  question: string,
  summary: DataSummary,
  chatHistory: Message[] = []
): Promise<SchemaColumnBindingResult> {
  const recentHistory = chatHistory
    .slice(-6)
    .map((msg) => `${msg.role}: ${msg.content}`)
    .join("\n");

  const columnsInfo = summary.columns.map((c) => `${c.name} [${c.type}]`).join(", ");
  const numericColumns = summary.numericColumns.join(", ") || "None";
  const dateColumns = summary.dateColumns.join(", ") || "None";
  const categoricalColumns =
    summary.columns
      .filter(
        (c) =>
          !summary.numericColumns.includes(c.name) &&
          !summary.dateColumns.includes(c.name)
      )
      .map((c) => c.name)
      .join(", ") || "None";

  const prompt = `You are an expert data analyst. Map the user's question to columns from this dataset.

USER QUESTION:
"""
${question}
"""

CONTEXT (recent conversation):
${recentHistory || "N/A"}

AVAILABLE COLUMNS IN DATASET:
${columnsInfo}

NUMERIC COLUMNS: ${numericColumns}
DATE COLUMNS: ${dateColumns}
CATEGORICAL COLUMNS: ${categoricalColumns}

TASK:
1. Identify ALL columns needed to answer the question (mentioned or implied).
2. Map conversational phrases to actual column names (e.g. "product categories" → the real category column name in the list).
3. Use EXACT spelling from AVAILABLE COLUMNS when possible.

COLUMN MATCHING RULES:
- Use EXACT column names from the available columns list
- Match synonyms: revenue, sales, amount, value → the appropriate numeric column
- Match related terms: "category", "categories", "product type" → the categorical dimension column
- Be case-insensitive; prefer the column whose name best matches the question

OUTPUT FORMAT (JSON only):
{
  "identifiedColumns": ["column1", "column2"],
  "columnMapping": {
    "product categories": "Exact Column Name From List",
    "sales": "Exact Numeric Column Name"
  },
  "reasoning": "one short sentence"
}

Output ONLY valid JSON.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You map analytical questions to dataset columns. Output only valid JSON. Every column name must appear in AVAILABLE COLUMNS.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 900,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No response for schema column binding");
    }

    const result = JSON.parse(content) as {
      identifiedColumns?: string[];
      columnMapping?: Record<string, string>;
      reasoning?: string;
    };

    const colList = summary.columns;
    const canonicalFromIds: string[] = [];
    if (Array.isArray(result.identifiedColumns)) {
      for (const raw of result.identifiedColumns) {
        if (typeof raw !== "string" || !raw.trim()) continue;
        const c = toCanonical(raw, colList);
        if (c) canonicalFromIds.push(c);
      }
    }

    const mapping: Record<string, string> = {};
    if (result.columnMapping && typeof result.columnMapping === "object") {
      for (const [k, v] of Object.entries(result.columnMapping)) {
        if (typeof v !== "string" || !v.trim()) continue;
        const c = toCanonical(v, colList);
        if (c) mapping[k.trim()] = c;
      }
    }

    const merged = dedupeCanonical([...canonicalFromIds, ...Object.values(mapping)]);

    return {
      canonicalColumns: merged,
      columnMapping: mapping,
      reasoning:
        typeof result.reasoning === "string" && result.reasoning.trim()
          ? result.reasoning.trim()
          : "Columns bound to dataset schema.",
    };
  } catch (e) {
    console.error("schemaColumnBinding: falling back to all columns", e);
    return {
      canonicalColumns: summary.columns.map((c) => c.name),
      columnMapping: {},
      reasoning: "Column binding failed; using full schema.",
    };
  }
}
