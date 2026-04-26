/**
 * Complex Query Detector
 * Uses AI to detect complex multi-condition queries that require special handling
 */
import { z } from 'zod';
import { callLlm } from './runtime/callLlm.js';
import { LLM_PURPOSE } from './runtime/llmCallPurpose.js';
import { getModelForTask } from './models.js';
import { DataSummary, Message } from '../../shared/schema.js';

/**
 * Complex Query Detection Schema
 */
export const complexQuerySchema = z.object({
  isComplex: z.boolean(),
  confidence: z.number().min(0).max(1),
  complexityReasons: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
});

export type ComplexQueryDetection = z.infer<typeof complexQuerySchema>;

/**
 * Cheap heuristic before calling the LLM in {@link detectComplexQuery}.
 * - If this returns **false**, the question is very unlikely to need the "force GeneralHandler"
 *   path, so we skip the extra LLM call (large latency win for simple questions).
 * - If **true**, run the full detector (bias toward safety when unsure).
 */
export function quickLikelyComplexQuery(question: string): boolean {
  const q = question.trim();
  if (q.length > 480) return true;

  const lower = q.toLowerCase();

  // Orchestrator fallback patterns (multi-condition "which … had …" queries)
  if (
    /which\s+(months|categories|skus|items|products).*had.*above/i.test(q) ||
    /which\s+(months|categories|skus|items|products).*had.*below/i.test(q) ||
    /which\s+(months|categories|skus|items|products).*compared.*while.*also/i.test(q) ||
    /which\s+(months|categories|skus|items|products).*above.*but.*only.*from/i.test(q)
  ) {
    return true;
  }

  if (/\bbut\s+only\b/.test(lower) || /\bwhile\s+also\b/.test(lower)) return true;

  if (
    /\b(above|below)\s+the\s+yearly\s+monthly\s+average\b/.test(lower) ||
    /\byearly\s+monthly\s+average\b/.test(lower)
  ) {
    return true;
  }

  if (/\bpercentile\b/.test(lower) || /\b(p75|p90|p95|median)\b/i.test(q)) return true;

  if (
    /\b(compared\s+to|compared\s+with|vs\.?|versus)\b/.test(lower) &&
    /\b(q[1-4]|quarter|year|month|yoy|qoq|mom)\b/i.test(lower)
  ) {
    return true;
  }

  if (/\byoy\b|\byear[\s-]*over[\s-]*year\b|\bqoq\b|\bmom\b/i.test(lower)) return true;

  if (/\b(category|sku)[\s-]*(month|year)[\s-]*(combinations?|pairs?)\b/i.test(lower)) {
    return true;
  }

  // "Which/what X had Y above [reference]" + average/mean in the same question often needs multi-step plans
  if (
    /\b(which|what)\s+\w+/.test(lower) &&
    /\b(above|below|exceeding)\b/.test(lower) &&
    /\b(average|mean|median)\b/.test(lower)
  ) {
    return true;
  }

  return false;
}

/**
 * Recursively remove ALL null values (Zod doesn't accept null for optional fields)
 */
function removeNulls(obj: any): any {
  if (obj === null || obj === undefined) {
    return undefined;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(removeNulls).filter(item => item !== undefined);
  }
  
  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = removeNulls(value);
      if (cleanedValue !== undefined) {
        cleaned[key] = cleanedValue;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  
  return obj;
}

/**
 * Detect if a query is complex using AI
 * Complex queries typically require:
 * - Multiple filters/conditions
 * - Aggregations combined with filters
 * - Comparisons to calculated values (averages, medians, etc.)
 * - Multiple grouping dimensions
 * - Temporal comparisons
 * - Conditional logic (AND/OR combinations)
 */
export async function detectComplexQuery(
  question: string,
  chatHistory: Message[],
  summary: DataSummary,
  maxRetries: number = 2
): Promise<ComplexQueryDetection> {
  // Build context from chat history
  const recentHistory = chatHistory
    .slice(-10)
    .filter(msg => msg.content && msg.content.length < 500)
    .map((msg) => `${msg.role}: ${msg.content}`)
    .join('\n');

  const historyContext = recentHistory ? `\n\nCONVERSATION HISTORY:\n${recentHistory}` : '';

  // Build available columns context
  const allColumns = summary.columns.map(c => c.name).join(', ');
  const numericColumns = (summary.numericColumns || []).join(', ');
  const dateColumns = (summary.dateColumns || []).join(', ');

  const prompt = `You are a query complexity analyzer for a data analysis AI assistant. Your task is to determine if a user's question is a "complex query" that requires special handling.

CURRENT QUESTION: ${question}
${historyContext}

AVAILABLE DATA:
- Total rows: ${summary.rowCount}
- Total columns: ${summary.columnCount}
- All columns: ${allColumns}
- Numeric columns: ${numericColumns}
${dateColumns ? `- Date columns: ${dateColumns}` : ''}

COMPLEX QUERY CRITERIA:
A query is considered "complex" if it requires ANY of the following:

1. MULTIPLE CONDITIONS/FILTERS:
   - Multiple filters combined with AND/OR logic
   - Examples: "Which months had revenue above average BUT only from category X"
   - Examples: "Which SKUs had sales > 1000 AND discount < 10% AND category = 'X'"
   - Examples: "Which categories had growth in Q4 compared to Q3, while also having sales above threshold"

2. REFERENCE-BASED COMPARISONS:
   - Comparisons to calculated values (averages, medians, percentiles, etc.)
   - Examples: "above the yearly monthly average", "below average", "above median"
   - Examples: "above the mean", "exceeding the 75th percentile"
   - Examples: "Which months had revenue above the yearly monthly average"

3. TEMPORAL COMPARISONS:
   - Comparing values across different time periods
   - Examples: "Which months had higher revenue in 2024 compared to 2023"
   - Examples: "Which categories grew from Q3 to Q4"
   - Examples: "Which SKUs had better performance this year vs last year"

4. MULTI-LEVEL AGGREGATIONS:
   - Aggregations combined with grouping and filtering
   - Examples: "Which categories had total revenue above X, but only counting orders with discount < 10%"
   - Examples: "Which months had sum of revenue above average, grouped by category"
   - Examples: "Which SKUs had average order size > 10, but only from repeat customers"

5. CONDITIONAL GROUPING:
   - Grouping with conditional filters
   - Examples: "Which months/categories/SKUs had X above Y, but only from [filtered subset]"
   - Examples: "Which products had sales above threshold, but only in specific regions"

6. NESTED CONDITIONS:
   - Conditions within conditions
   - Examples: "Which months had revenue above average, but only from orders where discount was below 10% AND category was X"
   - Examples: "Which categories had growth, but only for products with price > $50 AND rating > 4"

7. MULTIPLE DIMENSIONS:
   - Queries involving multiple grouping dimensions simultaneously
   - Examples: "Which category-month combinations had revenue above threshold"
   - Examples: "Which SKU-category pairs had sales growth"

SIMPLE QUERY EXAMPLES (NOT complex):
- "What is the average revenue?" → Simple statistical query
- "Show me revenue over time" → Simple chart request
- "What affects revenue?" → Simple correlation query
- "Which month had the highest revenue?" → Simple statistical query (single condition)
- "What is the sum of value for category X?" → Simple aggregation (single filter)
- "Show me trends in revenue" → Simple chart request

COMPLEX QUERY EXAMPLES:
- "Which months had total revenue above the yearly monthly average, but only from orders with discounts below 10%" → COMPLEX (multiple conditions + reference comparison)
- "Which SKUs had higher revenue in Q4 compared to Q3, while also selling more than 2,000 total units in the year" → COMPLEX (temporal comparison + multiple conditions)
- "Which categories had revenue growth in 2020 by value, but only for products with price above $50" → COMPLEX (temporal comparison + conditional filter)
- "Which months had revenue above average, but only from category X, and only for orders placed after 2020" → COMPLEX (reference comparison + multiple filters)
- "Which products had sales above threshold in Q4, but only counting repeat customers who ordered more than 5 times" → COMPLEX (temporal + conditional + nested conditions)

IMPORTANT NOTES:
- A query with a SINGLE condition (e.g., "above 1000") is usually NOT complex
- A query with a SINGLE filter (e.g., "for category X") is usually NOT complex
- Complexity comes from COMBINING multiple conditions, filters, aggregations, or comparisons
- Queries that require calculating averages/medians FIRST, then comparing, are complex
- Queries that compare across time periods are complex
- Queries with "but only", "while also", "and also", "combined with" often indicate complexity

OUTPUT FORMAT (JSON only, no markdown):
{
  "isComplex": true | false,
  "confidence": 0.0-1.0,
  "complexityReasons": ["reason1", "reason2"] | null,
  "reasoning": "Brief explanation of why this is/isn't complex" | null
}

Set confidence to 0.9+ if clearly complex, 0.7-0.9 if somewhat complex, <0.7 if simple.`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const model = getModelForTask('intent');
      
      const response = await callLlm(
        {
          model,
          messages: [
            {
              role: 'system',
              content: 'You are a query complexity analyzer. Output only valid JSON. Be precise in determining query complexity.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2, // Lower temperature for more consistent detection
          max_tokens: 300,
        },
        { purpose: LLM_PURPOSE.COMPLEX_QUERY_SCORE }
      );

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      // Parse JSON
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (parseError) {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1]);
        } else {
          throw parseError;
        }
      }

      // Recursively remove ALL null values
      const cleaned = removeNulls(parsed);
      
      // Validate with Zod schema
      if (!cleaned || typeof cleaned !== 'object') {
        throw new Error('Cleaned parsed result is invalid');
      }
      
      // Ensure required fields exist
      if (typeof cleaned.isComplex !== 'boolean' || typeof cleaned.confidence !== 'number') {
        throw new Error('Missing required fields: isComplex or confidence');
      }
      
      const validated = complexQuerySchema.parse(cleaned);
      
      console.log(`🔍 Complex query detection: ${validated.isComplex ? 'COMPLEX' : 'SIMPLE'} (confidence: ${validated.confidence.toFixed(2)})`);
      if (validated.complexityReasons && validated.complexityReasons.length > 0) {
        console.log(`   Reasons: ${validated.complexityReasons.join(', ')}`);
      }
      
      return validated;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`⚠️ Complex query detection attempt ${attempt + 1} failed:`, lastError.message);
      
      if (attempt < maxRetries - 1) {
        console.log(`🔄 Retrying complex query detection...`);
      }
    }
  }

  // If all retries failed, use fallback detection
  console.error('❌ Complex query detection failed after retries, using fallback');
  
  // Fallback: Use simple heuristics
  const questionLower = question.toLowerCase();
  const hasMultipleConditions = (
    (questionLower.includes('but') && questionLower.includes('only')) ||
    (questionLower.includes('while') && questionLower.includes('also')) ||
    (questionLower.includes('compared') && questionLower.includes('while')) ||
    (questionLower.includes('above') && questionLower.includes('below')) ||
    (questionLower.includes('above') && questionLower.includes('average') && questionLower.includes('but'))
  );
  
  const hasReferenceComparison = (
    questionLower.includes('above average') ||
    questionLower.includes('below average') ||
    questionLower.includes('above the') ||
    questionLower.includes('below the') ||
    questionLower.includes('yearly monthly average') ||
    questionLower.includes('monthly average')
  );
  
  const hasTemporalComparison = (
    questionLower.includes('compared to') ||
    questionLower.includes('compared with') ||
    questionLower.includes('vs') && (questionLower.includes('q') || questionLower.includes('quarter') || questionLower.includes('year'))
  );
  
  const isComplex = hasMultipleConditions || (hasReferenceComparison && hasTemporalComparison);
  
  return {
    isComplex,
    confidence: isComplex ? 0.7 : 0.3, // Lower confidence for fallback
    complexityReasons: isComplex 
      ? [
          hasMultipleConditions ? 'Multiple conditions detected' : '',
          hasReferenceComparison ? 'Reference-based comparison detected' : '',
          hasTemporalComparison ? 'Temporal comparison detected' : ''
        ].filter(Boolean)
      : undefined,
    reasoning: 'Fallback detection used due to AI detection failure',
  };
}
