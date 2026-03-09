import { z } from 'zod';
import { openai } from '../openai.js';
import { getModelForTask } from './models.js';
import type { DataSummary } from '../../shared/schema.js';

const filterConditionSchema = z.object({
  column: z.string(),
  operator: z.enum([
    '=',
    '!=',
    '>',
    '>=',
    '<',
    '<=',
    'contains',
    'startsWith',
    'endsWith',
    'between',
    'in',
  ]),
  value: z.any().optional(),
  value2: z.any().optional(),
  values: z.array(z.any()).optional(),
});

const chartOnFilterResultSchema = z.object({
  filterConditions: z.array(filterConditionSchema).optional(),
  chartType: z.enum(['line', 'bar', 'scatter', 'pie', 'area']).optional(),
});

export type ChartOnFilterParseResult = z.infer<typeof chartOnFilterResultSchema>;

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
 * Parse a chart-on-filter request into structured filter conditions and optional chart type.
 * Used only when mode="chartOnFiltered".
 */
export async function parseChartOnFilterRequest(
  question: string,
  summary: DataSummary,
  maxRetries: number = 2
): Promise<ChartOnFilterParseResult> {
  const columns = summary.columns?.map(c => c.name) || [];
  const allColumns = columns.join(', ');

  const prompt = `You are a parser for chart-on-filter requests.

The user is asking for a specific CHART (for example, a trend line, line chart, bar chart, pie chart, scatter plot, or area chart)
ON FILTERED DATA in a single question. Your job is to:
1) Extract the FILTER CONDITIONS that define which subset of rows to use.
2) Optionally extract the CHART TYPE if the user clearly specifies it.

QUESTION:
${question}

AVAILABLE COLUMNS (use ONLY these as column names in the output):
${allColumns || 'None'}

FILTER CONDITIONS:
- Each condition should describe a constraint on ONE column.
- Use operators:
  - "=" or "!=" for equality/inequality (case-insensitive for text)
  - ">", ">=", "<", "<=" for numeric comparisons
  - "contains", "startsWith", "endsWith" for text pattern matches
  - "between" for numeric/date ranges (use value and value2)
  - "in" when user lists multiple allowed values for the same column (use values array)
- Map phrases like:
  - "where product is PUREIT" → column: "product", operator: "=", value: "PUREIT"
  - "for category Beverages" → column: "category", operator: "=", value: "Beverages"
  - "only for region North" → column: "region", operator: "=", value: "North"
- ALWAYS use the exact column name from the available columns list when possible.
- If you cannot confidently map a phrase to a known column, DO NOT create a filter condition for it.

CHART TYPE:
- If the user explicitly mentions a chart type, set chartType accordingly:
  - "trend line" or "line chart" → "line"
  - "bar chart" → "bar"
  - "scatter" or "scatter plot" → "scatter"
  - "pie chart" → "pie"
  - "area chart" → "area"
- If the chart type is ambiguous or not mentioned, omit chartType (set to null).

OUTPUT STRICT JSON (no markdown, no comments):
{
  "filterConditions": [
    {
      "column": "ExactColumnNameFromList",
      "operator": "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "startsWith" | "endsWith" | "between" | "in",
      "value": any,
      "value2": any,
      "values": [any]
    }
  ] | [],
  "chartType": "line" | "bar" | "scatter" | "pie" | "area" | null
}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const model = getModelForTask('intent');

      const response = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a precise JSON API for parsing chart-on-filter requests. Output only valid JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 300,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (parseError) {
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1]);
        } else {
          throw parseError;
        }
      }

      const cleaned = removeNulls(parsed);
      if (!cleaned || typeof cleaned !== 'object') {
        throw new Error('Cleaned parsed result is invalid');
      }

      const validated = chartOnFilterResultSchema.parse(cleaned);
      const normalized: ChartOnFilterParseResult = {
        filterConditions: validated.filterConditions || [],
        chartType: validated.chartType,
      };

      console.log(
        `✅ Parsed chartOnFiltered request: ${normalized.filterConditions?.length || 0} filter conditions${
          normalized.chartType ? `, chartType=${normalized.chartType}` : ''
        }`
      );

      return normalized;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `⚠️ chartOnFilter parsing attempt ${attempt + 1} failed:`,
        lastError.message
      );
    }
  }

  console.error('❌ chartOnFilter parsing failed after retries, returning empty result');
  return {
    filterConditions: [],
  };
}

