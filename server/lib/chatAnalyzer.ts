/**
 * Chat Analyzer
 * Uses AI to analyze chat messages with extracted columns
 * This replaces RegEx-based analysis with AI-powered understanding
 */

import { openai, MODEL } from './openai.js';
import { DataSummary } from '../shared/schema.js';

export interface ChatAnalysisResult {
  intent: string;
  analysis: string;
  relevantColumns: string[];
  userIntent: string;
}

/**
 * Analyzes a chat message using AI with extracted columns
 * This function uses AI to understand what the user is asking about
 * 
 * @param message - The chat message to analyze
 * @param extractedColumns - Columns extracted using RegEx from the message
 * @param dataSummary - Data summary containing column information
 * @returns Analysis result with intent, analysis, and relevant columns
 */
export async function analyzeChatWithColumns(
  message: string,
  extractedColumns: string[],
  dataSummary: DataSummary
): Promise<ChatAnalysisResult> {
  const availableColumns = dataSummary.columns.map(c => c.name);
  const numericColumns = dataSummary.numericColumns || [];
  const dateColumns = dataSummary.dateColumns || [];

  const prompt = `You are a data analysis assistant. Analyze the user's chat message and understand what they are asking about.

USER MESSAGE:
"${message}"

EXTRACTED COLUMNS (from RegEx matching):
${extractedColumns.length > 0 ? extractedColumns.map(col => `- ${col}`).join('\n') : '- No columns explicitly mentioned'}

AVAILABLE COLUMNS IN DATASET:
${availableColumns.slice(0, 50).map(col => `- ${col}`).join('\n')}${availableColumns.length > 50 ? `\n... and ${availableColumns.length - 50} more columns` : ''}

NUMERIC COLUMNS:
${numericColumns.slice(0, 20).join(', ')}${numericColumns.length > 20 ? ` ... and ${numericColumns.length - 20} more` : ''}

DATE COLUMNS:
${dateColumns.length > 0 ? dateColumns.join(', ') : 'None'}

DATASET INFO:
- Total rows: ${dataSummary.rowCount}
- Total columns: ${dataSummary.columnCount}

TASK:
1. Understand what the user is asking about based on the message
2. Identify which columns are relevant to their question (from extracted columns and context)
3. Determine the user's intent (e.g., "compare columns", "analyze trends", "find correlations", "filter data", "general question", etc.)
4. Provide a clear analysis of what the user wants

OUTPUT FORMAT (JSON):
{
  "intent": "brief description of user intent (e.g., 'compare sales across regions', 'analyze revenue trends', 'find correlation between variables')",
  "analysis": "detailed analysis of what the user is asking, including context about relevant columns and what kind of analysis or visualization would help",
  "relevantColumns": ["array of column names that are relevant to the user's question"],
  "userIntent": "natural language description of what the user wants to accomplish"
}

IMPORTANT:
- EXTRACTED COLUMNS are names that literally appear in the user message (from deterministic matching). Treat them as authoritative for what the user referenced by name.
- Your relevantColumns MUST include every extracted column that is relevant to answering the question (metrics, dimensions, filters).
- Do NOT add extra columns only because they share words with an extracted name (e.g. "Sales", "Volume", "% Chg", "Share", "Price per") unless the user clearly asked for that metric (YoY change, share, index, etc.) or the question cannot be answered without them.
- You may add a date/time column (from DATE COLUMNS) when the user asks for trends, monthly views, or time series and a period column is needed.
- Only include columns that are actually relevant; prefer a small, sufficient set over listing every related field in the dataset.
- If the message is conversational and no columns were extracted, infer intent and choose the minimal relevant columns from AVAILABLE COLUMNS.
- Every name in relevantColumns must be spelled exactly as in AVAILABLE COLUMNS (case-sensitive).`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: 'system',
          content: 'You are a data analysis assistant. Analyze user messages to understand their intent and identify relevant columns. Always return valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 1000,
    });

    const content = response.choices[0].message.content || '{}';
    const parsed = JSON.parse(content);

    const byLower = new Map(availableColumns.map((c) => [c.toLowerCase(), c]));
    const rawRelevant = Array.isArray(parsed.relevantColumns) ? parsed.relevantColumns : [];
    const resolved = rawRelevant
      .filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c: string) => byLower.get(c.trim().toLowerCase()))
      .filter((c: string | undefined): c is string => c !== undefined);
    const relevantColumns: string[] = [];
    const seenRel = new Set<string>();
    for (const c of resolved) {
      if (!seenRel.has(c)) {
        seenRel.add(c);
        relevantColumns.push(c);
      }
    }

    return {
      intent: parsed.intent || 'unknown',
      analysis: parsed.analysis || '',
      relevantColumns,
      userIntent: parsed.userIntent || '',
    };
  } catch (error) {
    console.error('Error analyzing chat with AI:', error);
    // Fallback: return basic analysis
    return {
      intent: 'general',
      analysis: `User message: "${message}". Extracted columns: ${extractedColumns.join(', ') || 'none'}`,
      relevantColumns: extractedColumns,
      userIntent: message,
    };
  }
}

