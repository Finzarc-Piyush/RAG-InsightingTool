import { openai, MODEL } from "../../lib/openai.js";
import type { ChatDocument } from "../../models/chat.model.js";

/**
 * Generate a high-level semantic description of the dataset behind a chat session.
 *
 * This is stored in chatDocument.analysisMetadata.datasetSemantics and reused by
 * other semantic layers (business interpreter, metric resolver, etc.).
 */
export async function generateDatasetSemantics(
  chat: ChatDocument
): Promise<string> {
  const summary = chat.dataSummary;

  const columnsDesc = summary.columns
    .map(
      (c) =>
        `- ${c.name} [${c.type}] sampleValues=${JSON.stringify(
          c.sampleValues
        ).slice(0, 80)}`
    )
    .join("\n");

  const numericCols =
    summary.numericColumns.length > 0
      ? summary.numericColumns.join(", ")
      : "None";
  const dateCols =
    summary.dateColumns.length > 0 ? summary.dateColumns.join(", ") : "None";

  const statsSnippet = chat.dataSummaryStatistics
    ? JSON.stringify(chat.dataSummaryStatistics).slice(0, 2000)
    : "N/A";

  const prompt = `You are an expert analytics assistant.

Your task is to write a concise, high-level semantic description of the dataset
so that an LLM can later use it to interpret business questions.

DATASET METADATA:
- File name: ${chat.fileName}
- Rows: ${summary.rowCount}
- Columns: ${summary.columnCount}

COLUMNS:
${columnsDesc}

NUMERIC COLUMNS: ${numericCols}
DATE COLUMNS: ${dateCols}

DETAILED STATISTICS (if available, truncated):
${statsSnippet}

Write:
1. A one-paragraph description of what the dataset *appears* to represent (e.g. employee records, sales transactions).
2. A bullet list of 3–10 key business concepts (e.g. Employee, Department, Resignation, Hire Date).
3. A bullet list of 3–10 possible metrics that a business user might ask about (e.g. employee_count, resignations, attrition_rate).

Constraints:
- Use plain English, no markdown formatting.
- Do NOT invent columns that don't exist; if you infer concepts, connect them back to actual column names when possible.
- Keep the total output under 800 characters.
`;

  const response = await openai.chat.completions.create({
    model: MODEL as string,
    messages: [
      {
        role: "system",
        content:
          "You are a data semantics summarizer. Produce a compact, textual description of what this dataset represents and the key business concepts/metrics.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    max_tokens: 400,
  });

  const content = response.choices[0]?.message?.content?.trim() || "";
  return content;
}

