/**
 * `create_derived_column` data-op handler — extracted VERBATIM from
 * `executeDataOperation`'s switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Computes a new column from a formula (resolved from intent or — only when
 * missing — an AI extraction), delegates evaluation to the Python service
 * (`createDerivedColumn`), persists via `saveModifiedData`, then mutates
 * `sessionDoc.dataOpsContext.lastCreatedColumn` and writes it via a SECOND save
 * (`updateChatDocument`). The interleaving — persist data FIRST, THEN update the
 * context, THEN (only when `shouldShowPreview`) read back a preview — is
 * preserved exactly. A data-modification op: returns
 * `{ answer, data, preview, saved: true }`.
 *
 * The private helper `extractDerivedColumnDetails` (used ONLY by this branch) is
 * moved here UNCHANGED alongside the branch body. The only change vs. the
 * orchestrator is collapsing the captured locals into a single typed args
 * object (CQ-2).
 */
import { createDerivedColumn } from "../pythonService.js";
import { saveModifiedData, getPreviewFromSavedData } from "../dataPersistence.js";
import { updateChatDocument } from "../../../models/chat.model.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import { callLlm } from "../../agents/runtime/callLlm.js";
import { LLM_PURPOSE } from "../../agents/runtime/llmCallPurpose.js";
import { findMatchingColumn } from "../dataOpsValueHelpers.js";
import { logger } from "../../logger.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent, DataOpsContext } from "../dataOpsOrchestrator.js";

export interface CreateDerivedColumnArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  sessionId: string;
  sessionDoc?: ChatDocument;
  originalMessage?: string;
  shouldShowPreview: boolean;
}

export async function handleCreateDerivedColumn({
  intent,
  data,
  sessionId,
  sessionDoc,
  originalMessage,
  shouldShowPreview,
}: CreateDerivedColumnArgs): Promise<DataOpResult> {
  // Extract column name and expression if not already provided
  let newColumnName = intent.newColumnName;
  let expression = intent.expression;

  // If not provided, try to extract from message using AI
  if (!newColumnName || !expression) {
    const messageText = originalMessage || sessionDoc?.messages?.slice().reverse().find(m => m.role === 'user')?.content || '';
    const availableColumns = sessionDoc?.dataSummary?.columns?.map(c => c.name) || Object.keys(data[0] || {});

    const extraction = await extractDerivedColumnDetails(messageText, availableColumns);
    if (extraction) {
      newColumnName = newColumnName || extraction.columnName;
      expression = expression || extraction.expression;
    }
  }

  if (!newColumnName) {
    return {
      answer: 'Please specify a name for the new column. For example: "Create column XYZ = [Column A] + [Column B]"'
    };
  }

  if (!expression) {
    const availableColumns = sessionDoc?.dataSummary?.columns?.map(c => c.name) || Object.keys(data[0] || {});
    const columnsList = availableColumns.slice(0, 10).join(', ');
    return {
      answer: `Please specify the formula for column "${newColumnName}". For example: "Create column ${newColumnName} = [Column A] + [Column B]"\n\nAvailable columns: ${columnsList}${availableColumns.length > 10 ? '...' : ''}`
    };
  }

  // Log the expression and available columns for debugging
  const availableColumns = sessionDoc?.dataSummary?.columns?.map(c => c.name) || Object.keys(data[0] || {});
  logger.log(`🔍 Creating derived column "${newColumnName}" with expression: ${expression}`);
  logger.log(`📋 Available columns: ${availableColumns.slice(0, 10).join(', ')}${availableColumns.length > 10 ? '...' : ''}`);

  const result = await createDerivedColumn(data, newColumnName, expression);

  if (result.errors && result.errors.length > 0) {
    // Extract column names from the expression to provide better error messages
    const columnPattern = /\[([^\]]+)\]/g;
    const expressionColumns = [...expression.matchAll(columnPattern)].map(m => m[1]);
    const availableColumnsList = availableColumns.slice(0, 10).join(', ');

    let errorMessage = `Error creating column: ${result.errors.join('; ')}`;

    // If the error mentions a column not found, suggest similar columns
    if (result.errors.some(e => e.includes('not found'))) {
      errorMessage += `\n\nExpression columns: ${expressionColumns.join(', ')}`;
      errorMessage += `\nAvailable columns: ${availableColumnsList}${availableColumns.length > 10 ? '...' : ''}`;
      errorMessage += `\n\nPlease check that the column names in your expression match the available columns. Column names are case-sensitive.`;
    }

    return {
      answer: errorMessage
    };
  }

  // Save modified data first
  const saveResult = await saveModifiedData(
    sessionId,
    result.data,
    'create_derived_column',
    `Created derived column "${newColumnName}" with expression: ${expression}`,
    sessionDoc
  );

  // Update context to track last created column
  if (sessionDoc) {
    const context: DataOpsContext = {
      ...(sessionDoc.dataOpsContext as DataOpsContext || {}),
      lastCreatedColumn: newColumnName,
      timestamp: Date.now()
    };
    sessionDoc.dataOpsContext = context as any;
    await updateChatDocument(sessionDoc);
  }

  // Only show preview if user explicitly requested it
  let previewData: DataRow[] | undefined;
  let answerText = `✅ Successfully created column "${newColumnName}" with expression: ${expression}.`;

  if (shouldShowPreview) {
    previewData = await getPreviewFromSavedData(sessionId, result.data);
    answerText += `\n\nHere's a preview of the updated data:`;
  }

  return {
    answer: answerText,
    data: result.data,
    preview: previewData,
    saved: true
  };
}

// ---------------------------------------------------------------------------
// Private helper — moved VERBATIM from `dataOpsOrchestrator.ts`; used ONLY by
// the create_derived_column branch above.
// ---------------------------------------------------------------------------

/**
 * Extract derived column details using AI
 */
async function extractDerivedColumnDetails(
  message: string,
  availableColumns: string[]
): Promise<{ columnName: string; expression: string } | null> {
  try {
    const columnsList = availableColumns.slice(0, 30).join(', ');

    const prompt = `You are an expert data analyst who understands business metrics, financial calculations, statistical measures, and mathematical formulas. Your task is to extract the column name and expression from the user's query.

=== INTELLIGENT METRIC UNDERSTANDING ===
When the user requests a metric, calculation, or derived value WITHOUT explicitly providing the formula:

1. USE YOUR KNOWLEDGE: Draw upon your understanding of what the metric means:
   - Business metrics (ROI, profit margin, conversion rate, growth rate, etc.)
   - Financial metrics (EBITDA, net present value, payback period, etc.)
   - Statistical measures (correlation, variance, z-score, percentile, etc.)
   - Mathematical operations (ratios, percentages, averages, etc.)

2. INFER THE FORMULA: Based on standard definitions and best practices:
   - Understand the mathematical relationship (division, multiplication, addition, subtraction, etc.)
   - Determine if it's a ratio, percentage, rate, or absolute value
   - Consider whether to multiply by 100 for percentages
   - Handle edge cases (division by zero, negative values, etc.)

3. SEMANTIC COLUMN MATCHING: Intelligently match columns based on meaning, not just exact names:
   - Use synonyms and related terms (Revenue = Sales = Income, Cost = Expense = Spend, Profit = Net Profit = Earnings)
   - Match partial names (if user says "revenue" and column is "Total Revenue", match it)
   - Consider context (if calculating ROI, look for revenue/profit and cost/investment columns)
   - Use fuzzy matching: ignore case, spaces, underscores, dashes
   - Prefer the most semantically relevant column when multiple matches exist

4. CONSTRUCT THE EXPRESSION:
   - Use [ColumnName] format where ColumnName matches EXACTLY from available columns
   - For percentages/rates, multiply by 100 (unless user specifies decimal format)
   - For division operations, use np.where to handle division by zero: np.where([Denominator] != 0, [Numerator] / [Denominator], 0)
   - Use standard mathematical operators: +, -, *, /, ** (for power)

=== EXAMPLES OF INTELLIGENT INFERENCE ===

Example 1: "create column ROI"
- You know ROI = (Return / Investment) * 100 or ((Revenue - Cost) / Cost) * 100
- Look for columns like: Revenue, Sales, Income, Profit, Net Profit, Cost, Expense, Spend, Investment
- If you find "Revenue" and "Cost": expression: "(([Revenue] - [Cost]) / [Cost]) * 100"
- If you find "Profit" and "Investment": expression: "([Profit] / [Investment]) * 100"
- Handle division by zero: "np.where([Cost] != 0, (([Revenue] - [Cost]) / [Cost]) * 100, 0)"

Example 2: "create column Profit Margin"
- You know Profit Margin = (Profit / Revenue) * 100
- Match "Profit" or "Net Profit" and "Revenue" or "Sales"
- Expression: "np.where([Revenue] != 0, ([Profit] / [Revenue]) * 100, 0)"

Example 3: "create column Growth Rate"
- You know Growth Rate = ((Current - Previous) / Previous) * 100
- Look for time-sequenced columns or current/previous indicators
- Expression: "np.where([Previous] != 0, (([Current] - [Previous]) / [Previous]) * 100, 0)"

Example 4: "create column Conversion Rate"
- You know Conversion Rate = (Conversions / Total) * 100
- Match columns like Conversions, Sales, Leads, Visitors, Clicks
- Expression: "np.where([Total Visitors] != 0, ([Conversions] / [Total Visitors]) * 100, 0)"

=== COLUMN MATCHING STRATEGY ===
1. First, try exact case-insensitive match
2. Then, try normalized match (ignore spaces, underscores, dashes)
3. Then, try partial match (contains the search term)
4. Then, try semantic match (synonyms, related terms)
5. If multiple matches, prefer the most semantically relevant one
6. If no match found, use the closest numeric column that makes sense contextually

Extract the new column name and expression from the user's query for creating a derived column.

User query: "${message}"

Available columns: ${columnsList}

CRITICAL: You MUST use EXACT column names from the available columns list above. Match column names case-sensitively and exactly as they appear in the list.

Extract:
1. newColumnName: The name of the new column to create
2. expression: The formula using [ColumnName] format where ColumnName must match EXACTLY one of the available columns

Examples:
- "create column XYZ with value of each row is the sum of PA nGRP Adstocked and PAB nGRP Adstocked"
  → columnName: "XYZ", expression: "[PA nGRP Adstocked] + [PAB nGRP Adstocked]"
- "create column Total = Price * Quantity"
  → columnName: "Total", expression: "[Price] * [Quantity]"
- "add two columns X and Y and name it Sum"
  → columnName: "Sum", expression: "[X] + [Y]"
- "create column xyz where if qty_ordered is more than the mean of qty_ordered then put it as 'outperform' otherwise 'notperforming'"
  → columnName: "xyz", expression: "np.where([qty_ordered] > [qty_ordered].mean(), 'outperform', 'notperforming')"
- "add column status where if price > 100 then 'high' else 'low'"
  → columnName: "status", expression: "np.where([price] > 100, 'high', 'low')"
- "create column category where if quantity > mean(quantity) then 'above_average' otherwise 'below_average'"
  → columnName: "category", expression: "np.where([quantity] > [quantity].mean(), 'above_average', 'below_average')"

Rules:
- Use [ColumnName] format for column references
- CRITICAL: For conditional logic (if/then/else), you MUST use np.where(condition, value_if_true, value_if_false) format
- NEVER use Python ternary operator (value_if_true if condition else value_if_false) - this will cause errors with arrays
- For mean/average of a column, use [ColumnName].mean()
- For comparisons: "more than" or "greater than" → >, "less than" → <, "equal to" → ==, "not equal" → !=
- String values should be in quotes: 'value' or "value"
- Default operation when multiple columns are mentioned is addition (+)
- Match column names to available columns (case-insensitive)
- When comparing a column to its mean: use [ColumnName] > [ColumnName].mean() inside np.where()

Return JSON:
{
  "columnName": "NewColumnName",
  "expression": "[Column1] + [Column2]" or "np.where([Column1] > [Column1].mean(), 'value1', 'value2')"
}`;

    const response = await callLlm(
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert data analyst who understands business metrics, financial calculations, and statistical measures. You intelligently infer formulas from metric names using your knowledge. Return only valid JSON.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 500,
      },
      { purpose: LLM_PURPOSE.DATAOPS_COMPUTED_COL }
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.columnName && parsed.expression) {
      // Match column names in expression to actual column names
      let expression = parsed.expression;
      const columnPattern = /\[([^\]]+)\]/g;
      const matches = [...expression.matchAll(columnPattern)];

      // Track which columns were matched and which weren't
      const unmatchedColumns: string[] = [];

      for (const match of matches) {
        const colRef = match[1];
        // Try to match the column name
        const matchedCol = findMatchingColumn(colRef, availableColumns);
        if (matchedCol) {
          // Replace all occurrences of this column reference
          expression = expression.replace(new RegExp(`\\[${colRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'g'), `[${matchedCol}]`);
          logger.log(`✅ Matched column reference "${colRef}" → "${matchedCol}"`);
        } else {
          unmatchedColumns.push(colRef);
          logger.warn(`⚠️ Could not match column reference: "${colRef}"`);
        }
      }

      // If there are unmatched columns, log available columns for debugging
      if (unmatchedColumns.length > 0) {
        logger.warn(`⚠️ Unmatched columns: ${unmatchedColumns.join(', ')}`);
        logger.warn(`📋 Available columns (first 20): ${availableColumns.slice(0, 20).join(', ')}`);
      }

      return {
        columnName: parsed.columnName.trim(),
        expression: expression.trim(),
      };
    }

    return null;
  } catch (error) {
    logger.error('Error extracting derived column details:', error);
    return null;
  }
}
